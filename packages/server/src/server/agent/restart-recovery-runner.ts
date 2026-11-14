// Local fork (DASEO.md delta 44): delivers what restart-recovery.ts journaled. See that file for
// the why; this file only wires it to the agent manager, storage, and prompt paths.

import type { Logger } from "pino";

import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import {
  archivesOnFinish,
  deliverFinishNotification,
  finishReportHash,
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  setupFinishNotification,
} from "./agent-prompt.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  type AgentWaitState,
  formatRecoveryNotice,
  JOURNAL_MAX_AGE_MS,
  type JournalWatcherEntry,
  type RecoveryJournal,
  type RecoveryNotice,
  type RestartRecoveryJournal,
} from "./restart-recovery.js";

export function toAgentWaitState(agent: ManagedAgent): AgentWaitState {
  return {
    agentId: agent.id,
    pendingBackgroundWaits: agent.pendingBackgroundWaits ?? 0,
    backgroundWaitLabels: agent.backgroundWaitLabels ?? [],
    running: agent.lifecycle === "running" || agent.lifecycle === "initializing",
    closed: agent.lifecycle === "closed",
  };
}

interface RecoveryDeps {
  journal: RestartRecoveryJournal;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/** Prompt one agent with a recovery notice, unless it is gone or inside its cooldown. */
export async function deliverRecoveryNotice(
  deps: RecoveryDeps,
  notice: RecoveryNotice,
): Promise<boolean> {
  const record = await deps.agentStorage.get(notice.agentId);
  if (!record || record.archivedAt || record.internal) return false;
  if (!deps.journal.claimRecovery(notice.agentId)) {
    deps.logger.warn(
      { agentId: notice.agentId, cause: notice.cause },
      "restart_recovery.notice_skipped_cooldown",
    );
    return false;
  }
  try {
    await sendPromptToAgent({
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      agentId: notice.agentId,
      prompt: formatSystemNotificationPrompt(formatRecoveryNotice(notice)),
      unarchive: false,
      logger: deps.logger,
    });
    deps.logger.info(
      {
        agentId: notice.agentId,
        cause: notice.cause,
        lostWaits: notice.lostWaits?.pending ?? 0,
        turnInterrupted: notice.turnInterrupted === true,
      },
      "restart_recovery.notice_sent",
    );
    return true;
  } catch (error) {
    deps.logger.error({ err: error, agentId: notice.agentId }, "restart_recovery.notice_failed");
    return false;
  }
}

function collectLostNotices(
  previous: RecoveryJournal,
  writtenAt: Date,
): Map<string, RecoveryNotice> {
  const lostById = new Map<string, RecoveryNotice>();
  for (const [agentId, entry] of Object.entries(previous.agents)) {
    const lostWaits = entry.waits && entry.waits.pending > 0 ? entry.waits : undefined;
    if (!lostWaits && !entry.running) continue;
    lostById.set(agentId, {
      agentId,
      cause: "daemon_restart",
      ...(lostWaits ? { lostWaits } : {}),
      ...(entry.running ? { turnInterrupted: true } : {}),
      at: writtenAt,
    });
  }
  return lostById;
}

/**
 * Re-arm a watcher whose child is about to be woken, deliver the finish notification of a child
 * that had already settled when the shutdown cut the notification off, and re-arm the continuing
 * watch of a child whose caller had nothing owed (delta 106) without loading that child.
 */
async function recoverWatcher(
  deps: RecoveryDeps,
  childAgentId: string,
  watcher: JournalWatcherEntry,
  childWillBeWoken: boolean,
): Promise<"rearmed" | "delivered" | "skipped"> {
  try {
    const [child, caller] = await Promise.all([
      deps.agentStorage.get(childAgentId),
      deps.agentStorage.get(watcher.callerAgentId),
    ]);
    if (!child || child.archivedAt || !caller || caller.archivedAt) return "skipped";
    const finishOwed = watcher.finishOwed ?? true;
    const archiveOnFinish = archivesOnFinish(child.labels);
    const watch = (resume?: { finishOwed: boolean; lastReportHash: string | null }) =>
      setupFinishNotification({
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        childAgentId,
        callerAgentId: watcher.callerAgentId,
        requireParentOwnership: watcher.requireParentOwnership,
        ...(resume ? { resume: { ...resume, archiveOnFinish } } : {}),
        logger: deps.logger,
      });
    const continuing = { finishOwed: false, lastReportHash: watcher.lastReportHash ?? null };
    if (!finishOwed && !childWillBeWoken) {
      // Nothing owed and nothing to wake: listen again, and leave the child unloaded until used.
      watch(continuing);
      return "rearmed";
    }
    await ensureAgentLoaded(childAgentId, {
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      logger: deps.logger,
    });
    if (childWillBeWoken) {
      watch(finishOwed ? undefined : continuing);
      return "rearmed";
    }
    const message = await deps.agentManager.getLastAssistantMessage(childAgentId);
    const delivery = await deliverFinishNotification({
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      childAgentId,
      callerAgentId: watcher.callerAgentId,
      requireParentOwnership: watcher.requireParentOwnership,
      reason: child.lastStatus === "error" ? "errored" : "finished",
      archiveAfter: archiveOnFinish,
      lastAssistantMessage: message,
      logger: deps.logger,
    });
    if (delivery !== "delivered") return "skipped";
    if (!archiveOnFinish && getParentAgentIdFromLabels(child.labels) === watcher.callerAgentId) {
      watch({ finishOwed: false, lastReportHash: message ? finishReportHash(message) : null });
    }
    return "delivered";
  } catch (error) {
    deps.logger.error({ err: error, childAgentId }, "restart_recovery.watcher_failed");
    return "skipped";
  }
}

export interface RestartRecoveryResult {
  notified: string[];
  rearmed: string[];
  delivered: string[];
  skippedStale: boolean;
}

/**
 * After a start: re-arm journaled child watchers, deliver a finish notification the shutdown cut
 * off, and prompt every agent whose waits or turn the restart killed.
 */
export async function runRestartRecovery(
  deps: RecoveryDeps & { previous: RecoveryJournal | null; now?: () => Date },
): Promise<RestartRecoveryResult> {
  const result: RestartRecoveryResult = {
    notified: [],
    rearmed: [],
    delivered: [],
    skippedStale: false,
  };
  const previous = deps.previous;
  if (!previous) return result;
  const now = (deps.now ?? (() => new Date()))();
  const writtenAt = new Date(previous.writtenAt);
  if (
    !Number.isFinite(writtenAt.getTime()) ||
    now.getTime() - writtenAt.getTime() > JOURNAL_MAX_AGE_MS
  ) {
    deps.logger.warn({ writtenAt: previous.writtenAt }, "restart_recovery.journal_stale");
    result.skippedStale = true;
    return result;
  }

  const lostById = collectLostNotices(previous, writtenAt);

  // Watchers first, so a child woken below reports its finish to its parent.
  for (const [childAgentId, watcher] of Object.entries(previous.watchers)) {
    const outcome = await recoverWatcher(deps, childAgentId, watcher, lostById.has(childAgentId));
    if (outcome === "rearmed") result.rearmed.push(childAgentId);
    if (outcome === "delivered") result.delivered.push(childAgentId);
  }

  for (const notice of lostById.values()) {
    if (await deliverRecoveryNotice(deps, notice)) result.notified.push(notice.agentId);
  }
  deps.logger.info(
    {
      notified: result.notified.length,
      rearmed: result.rearmed.length,
      delivered: result.delivered.length,
    },
    "restart_recovery.done",
  );
  return result;
}
