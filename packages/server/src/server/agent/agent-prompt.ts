import { createHash } from "node:crypto";
import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
  AgentTimelineItem,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { archiveAgentCommand } from "./lifecycle-command.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "trySteerAgentRun"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "streamAgent"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
}

// This coordinator intentionally keeps out-of-band, steer, replace, and drain
// policy in one place so every prompt entrypoint shares identical ordering.
// oxlint-disable-next-line complexity
export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ outOfBand: boolean }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { outOfBand: true };
  }
  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  const runOptions = options?.runOptions;
  if (
    options?.replaceRunning &&
    hasInFlightRun &&
    (await agentManager.trySteerAgentRun(agentId, prompt, runOptions))
  ) {
    logger.trace(
      {
        agentId,
        provider: snapshot?.provider,
        providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        turnId: snapshot?.activeForegroundTurnId ?? undefined,
      },
      "agent.session.steer.accepted",
    );
    return { outOfBand: false };
  }
  const shouldReplace = Boolean(options?.replaceRunning && hasInFlightRun);
  const iterator = shouldReplace
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { outOfBand: false };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

/**
 * Mark a provider-reported prompt that carries the system envelope. The row
 * stays in the timeline as the boundary where the triggered response begins;
 * `origin` lets clients render it as a system row instead of a user bubble.
 */
export function withSystemPromptOrigin(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "user_message" || !isSystemInjectedEnvelope(item.text)) {
    return item;
  }
  return item.origin === "system" ? item : { ...item, origin: "system" };
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const startAbort = new AbortController();
  const startTimeout = setTimeout(() => startAbort.abort("timeout"), AGENT_RUN_START_TIMEOUT_MS);

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns `{ outOfBand: false }`) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ outOfBand: boolean }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { outOfBand: false };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

/**
 * Local fork (DASEO.md delta 103): a sub-agent created with `archiveOnFinish` carries this label,
 * so every finish watcher for it (the one create_agent starts, a send_agent_prompt follow-up, one
 * re-armed after a daemon restart) archives it once its finish has been handed to the caller.
 * Research workers are never prompted again, and a lead busy in another turn archived them late or
 * not at all (27 of 1,232 workers by 2026-11-13). The archive comes after delivery because the
 * notice reads the child's last message, which is gone once the child leaves the manager.
 */
export const ARCHIVE_ON_FINISH_LABEL = "paseo.archive-on-finish";

export function archivesOnFinish(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[ARCHIVE_ON_FINISH_LABEL] === "true";
}

interface ArchiveFinishedChildParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  logger: Logger;
}

/** Archive through the same command as `archive_agent`, so cascade and client updates match. */
export async function archiveFinishedChild(params: ArchiveFinishedChildParams): Promise<void> {
  const { agentManager, agentStorage, childAgentId, logger } = params;
  const record = await agentStorage.get(childAgentId);
  if (!record || record.archivedAt) return;
  try {
    await archiveAgentCommand({ agentManager, agentStorage, logger }, childAgentId);
  } catch (error) {
    logger.error(
      { err: error, childAgentId },
      "Failed to archive a finished archiveOnFinish agent",
    );
  }
}

/**
 * Local fork (delta 103): `archiveOnFinish` without `notifyOnFinish` has no notice to wait for, so
 * the child is archived when its first turn ends (or errors) and it holds no background wait.
 */
export function archiveAfterFirstTurn(params: ArchiveFinishedChildParams): void {
  const { agentManager, childAgentId } = params;
  let hasSeenRunning = false;
  let done = false;
  let unsubscribe: (() => void) | null = null;

  function finish(archive: boolean): void {
    if (done) return;
    done = true;
    unsubscribe?.();
    if (archive) void archiveFinishedChild(params);
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (done || event.type !== "agent_state") return;
      const { lifecycle } = event.agent;
      if (lifecycle === "running") {
        if (event.agent.pendingPermissions.size === 0) hasSeenRunning = true;
        return;
      }
      if (lifecycle === "closed") {
        finish(false);
        return;
      }
      if (lifecycle === "error") {
        finish(true);
        return;
      }
      if (
        lifecycle === "idle" &&
        hasSeenRunning &&
        (event.agent.pendingBackgroundWaits ?? 0) === 0
      ) {
        finish(true);
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    finish(false);
  } else if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    finish(true);
  }
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  /**
   * Restart recovery (deltas 44, 106): re-arm a watch with the state its journal entry kept,
   * instead of owing the caller a new finish. The child may still be unloaded.
   */
  resume?: ResumedFinishWatch;
  logger: Logger;
}

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "needs permission"
  | "was closed"
  | typeof STALL_NOTIFICATION_REASON
  | typeof LEAD_REVIEW_NOTIFICATION_REASON;

/**
 * Local fork (DASEO.md delta 54): a child that stays "running" with no event for this long is
 * reported to its caller once per silent stretch. The caller waits on a message and is told not to
 * poll, so a child stuck mid-run (a hung provider stream, a tool that never returns) otherwise left
 * it waiting with no deadline at all (2026-10-23 wait audit). Any child event resets the clock.
 */
export const FINISH_WATCH_STALL_MS = 20 * 60_000;
export const FINISH_WATCH_STALL_CHECK_MS = 60_000;
const STALL_NOTIFICATION_REASON = "has shown no progress for 20 minutes";

/**
 * Local fork (DASEO.md delta 80): delta 29 keeps "finished" quiet while the child still holds
 * background waits, because a child that ends its turn to let a build run is not done. A child can
 * also end its turn with a report that waits on its caller (a QA gate, a decision) while one of its
 * own waits is still pending; on 2026-11-05 a phase-10 implementer did exactly that, its lead never
 * heard, and the owner answered "GO" in the child's tab, skipping the lead's review. A report that
 * carries this marker on a line of its own is delivered at once, as a non-terminal notice, and the
 * watch continues; the later finish is delivered only if the child says something new.
 */
export const LEAD_REVIEW_MARKER = "[lead review]";
const LEAD_REVIEW_NOTIFICATION_REASON = "is waiting for your review";
const WAIT_NOTED_REPLY = "[wait noted]";

export function asksForLeadReview(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.split(/\r?\n/).some((line) => line.trim().toLowerCase() === LEAD_REVIEW_MARKER);
}

/**
 * Local fork (DASEO.md delta 106): a watch lasts as long as the parent-child relation, not until
 * the first notice. A child's later turn (its own sub-agent's notice, a wait wake, a schedule, an
 * automatic resume, the owner typing in its tab) used to end silently, and its lead waited on a
 * report it never got (2026-11-13: 114 minutes). These bound what the longer watches cost.
 *
 * A child that ended its turn while sub-agents it started with a finish watch are still working is
 * not finished either: its "finished" is held like a background wait (delta 29) until their
 * notices have reached it. A sub-agent that shows no activity for SUB_AGENT_HOLD_MAX_MS stops
 * holding it; a timer measures that, not the next state change.
 */
export const SUB_AGENT_HOLD_MAX_MS = 61 * 60_000;
/** A continuing watch (nothing owed, nothing held) whose child has been quiet this long ends. */
export const CONTINUED_WATCH_MAX_QUIET_MS = 7 * 24 * 60 * 60_000;
/** At most this many watches live at once; the quietest continuing watch makes room. */
export const MAX_LIVE_FINISH_WATCHERS = 500;

/** Identifies a report the caller already received, without keeping its text in the journal. */
export function finishReportHash(message: string): string {
  return createHash("sha256").update(message).digest("hex").slice(0, 16);
}

interface LiveFinishWatcher {
  readonly childAgentId: string;
  readonly callerAgentId: string;
  /** The caller asked for the child's next finish again (send_agent_prompt with notifyOnFinish). */
  refresh(requireParentOwnership: boolean): void;
  /** When this watch stops holding its caller's own finish; null when it does not hold it. */
  holdsCallerUntil(): number | null;
  /** Re-evaluate a child idle-held on its sub-agents: one of their watches ended or timed out. */
  recheckHold(): void;
  /** The child's last activity when this watch may be dropped to make room, else null. */
  evictableSince(): number | null;
  /** End the watch without a notice and leave the journal. */
  end(reason: string): void;
  /** The caller reads the next turn's result itself; do not report that turn again. */
  callerReadsNextTurn(): void;
}

/**
 * Local fork (delta 80): one live watcher per (child, caller). Every send_agent_prompt with
 * notifyOnFinish used to add another; a lead that sent seven follow-ups to a running implementer got
 * the same finish notice seven times (2026-11-04, 14:21 KST), each one a paid turn. Delta 106: a
 * new request refreshes the live watcher instead of replacing it.
 */
interface FinishWatchRegistry {
  live: Map<string, LiveFinishWatcher>;
  /**
   * Delta 106: watches whose caller is waiting on their notice. Separate from `live` so a watch
   * that stopped before its last notice was sent keeps holding the caller until it is sent.
   */
  holdingCaller: Set<LiveFinishWatcher>;
}

/** One registry per agent manager: the daemon has one, and each test builds its own. */
const finishWatchRegistries = new WeakMap<AgentManager, FinishWatchRegistry>();

function finishWatchRegistry(agentManager: AgentManager): FinishWatchRegistry {
  let registry = finishWatchRegistries.get(agentManager);
  if (!registry) {
    registry = { live: new Map(), holdingCaller: new Set() };
    finishWatchRegistries.set(agentManager, registry);
  }
  return registry;
}

function finishWatcherKey(childAgentId: string, callerAgentId: string): string {
  return `${childAgentId}\u0000${callerAgentId}`;
}

interface SubAgentHold {
  count: number;
  /** The earliest moment one of them stops holding, or null when none holds. */
  until: number | null;
}

function subAgentHold(
  registry: FinishWatchRegistry,
  callerAgentId: string,
  now: number,
): SubAgentHold {
  let count = 0;
  let until: number | null = null;
  for (const watcher of registry.holdingCaller) {
    if (watcher.callerAgentId !== callerAgentId) continue;
    const holdsUntil = watcher.holdsCallerUntil();
    if (holdsUntil === null || holdsUntil <= now) continue;
    count += 1;
    until = until === null ? holdsUntil : Math.min(until, holdsUntil);
  }
  return { count, until };
}

function recheckHoldsOf(registry: FinishWatchRegistry, agentId: string): void {
  // A recheck can end a watch; deleting from a Map while iterating it is safe.
  for (const watcher of registry.live.values()) {
    if (watcher.childAgentId === agentId) watcher.recheckHold();
  }
}

function makeRoomForWatcher(registry: FinishWatchRegistry): void {
  while (registry.live.size >= MAX_LIVE_FINISH_WATCHERS) {
    let quietest: LiveFinishWatcher | null = null;
    let quietestSince = Number.POSITIVE_INFINITY;
    for (const watcher of registry.live.values()) {
      const since = watcher.evictableSince();
      if (since !== null && since < quietestSince) {
        quietest = watcher;
        quietestSince = since;
      }
    }
    if (!quietest) return;
    quietest.end("evicted");
  }
}

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
  archiveAfter?: boolean;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "errored") {
    sections.push(
      params.archiveAfter
        ? "Daseo archives this agent after this notice because it was created with archiveOnFinish; send_agent_prompt unarchives it and runs it again."
        : "Daseo keeps watching this agent: if it recovers and finishes, you will be notified again.",
    );
  }
  if (params.reason === LEAD_REVIEW_NOTIFICATION_REASON) {
    sections.push(
      "It ended its turn with a report for you while it still holds background waits or sub-agents of its own. Daseo keeps watching: you are told again only if it says something new after they finish.",
    );
  }
  if (params.reason === STALL_NOTIFICATION_REASON) {
    sections.push(
      "It is still marked running but has produced no output, tool call, or state change in that time. Look at it with `get_agent_activity`; if it is stuck, stop it with `cancel_agent` and decide whether to retry. Daseo keeps watching: you will still be notified when it finishes.",
    );
  }
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
  archiveAfter?: boolean;
}

/** Notices after which the caller no longer waits on this child (delta 106). */
const CALLER_RELEASING_REASONS: ReadonlySet<FinishNotificationReason> = new Set([
  "finished",
  "errored",
  "was closed",
  LEAD_REVIEW_NOTIFICATION_REASON,
]);

/** Delta 106: what a watch owes its caller, kept in the journal so a restart re-arms it as is. */
export interface FinishWatchState {
  /** The caller asked for the child's next finish and has not been told yet. */
  finishOwed: boolean;
  /** `finishReportHash` of the last report delivered as a finish or review notice. */
  lastReportHash: string | null;
}

export interface ResumedFinishWatch extends FinishWatchState {
  archiveOnFinish: boolean;
}

/**
 * Local fork (DASEO.md delta 44): a watcher lives in daemon memory, so it is journaled to survive a
 * restart. An entry leaves the journal when the watch ends (or can never deliver); while the daemon
 * shuts down nothing is delivered and the entry stays for the next start. Delta 106: the entry also
 * carries the watch's state, updated whenever it changes.
 */
export interface FinishWatcherJournal {
  addWatcher(
    childAgentId: string,
    callerAgentId: string,
    requireParentOwnership: boolean,
    state?: FinishWatchState,
  ): void;
  removeWatcher(childAgentId: string, callerAgentId: string): void;
  isFrozen(): boolean;
}

let finishWatcherJournal: FinishWatcherJournal | null = null;

export function setFinishWatcherJournal(journal: FinishWatcherJournal | null): void {
  finishWatcherJournal = journal;
}

export type FinishNotificationDelivery =
  | "delivered"
  | "caller-gone"
  | "not-owned"
  | "shutting-down";

/**
 * Send one finish notification for `childAgentId` to `callerAgentId`. With `archiveAfter` the child
 * is archived once the notice has been handed to the caller, or when the caller is archived and
 * can never receive it; never before, because the notice reads the child's last message.
 * `lastAssistantMessage` passes a message already read, so the notice carries the exact report the
 * watcher decided on.
 */
export async function deliverFinishNotification(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership: boolean;
  reason: FinishNotificationReason;
  permissionRequest?: AgentPermissionRequest;
  archiveAfter?: boolean;
  lastAssistantMessage?: string | null;
  logger: Logger;
}): Promise<FinishNotificationDelivery> {
  const delivery = await composeAndSendFinishNotification(params);
  if (params.archiveAfter && (delivery === "delivered" || delivery === "caller-gone")) {
    await archiveFinishedChild({
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      childAgentId: params.childAgentId,
      logger: params.logger,
    });
  }
  return delivery;
}

async function composeAndSendFinishNotification(
  params: Parameters<typeof deliverFinishNotification>[0],
): Promise<FinishNotificationDelivery> {
  const { agentManager, agentStorage, childAgentId, callerAgentId } = params;
  if (finishWatcherJournal?.isFrozen()) {
    return "shutting-down";
  }
  const callerRecord = await agentStorage.get(callerAgentId);
  if (callerRecord?.archivedAt) {
    return "caller-gone";
  }

  const record = await agentStorage.get(childAgentId);
  if (
    params.requireParentOwnership &&
    getParentAgentIdFromLabels(record?.labels) !== callerAgentId
  ) {
    return "not-owned";
  }
  const title = record?.title ?? childAgentId;
  const lastAssistantMessage =
    params.lastAssistantMessage !== undefined
      ? params.lastAssistantMessage
      : await agentManager.getLastAssistantMessage(childAgentId);
  const body = formatFinishNotificationBody({
    childAgentId,
    title,
    reason: params.reason,
    lastAssistantMessage,
    permissionRequest: params.permissionRequest,
    archiveAfter: params.archiveAfter,
  });

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: callerAgentId,
    prompt: formatSystemNotificationPrompt(body),
    unarchive: false,
    logger: params.logger,
  });
  return "delivered";
}

/**
 * Watch `childAgentId` for `callerAgentId` (DASEO.md deltas 29, 44, 54, 80, 103, 106).
 *
 * | Child event                                              | Notice to the caller             |
 * | -------------------------------------------------------- | -------------------------------- |
 * | idle, background waits or watched sub-agents pending     | none; `[lead review]` report: review notice |
 * | idle, a finish owed (create_agent, send_agent_prompt)    | finished                         |
 * | idle, nothing owed, a new report                         | finished (owned children only)   |
 * | idle, nothing owed, same report, empty, `[wait noted]`   | none                             |
 * | error / permission / 20 min silent while running         | errored / needs permission / stall |
 * | closed while a finish is owed or held                    | was closed (watch ends)          |
 * | closed otherwise, caller archived, child detached        | none (watch ends)                |
 *
 * An archiveOnFinish child keeps delta 103: its first finish or error is the last notice.
 */
/**
 * Delta 106: a caller that prompts a child it watches without asking for the finish
 * (`send_agent_prompt` with `background: false`, which returns the result, or with
 * `notifyOnFinish: false`) is not sent that turn's report by the continuing watch.
 */
export function callerReadsNextTurn(params: {
  agentManager: AgentManager;
  childAgentId: string;
  callerAgentId: string;
}): void {
  finishWatchRegistry(params.agentManager)
    .live.get(finishWatcherKey(params.childAgentId, params.callerAgentId))
    ?.callerReadsNextTurn();
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const existing = finishWatchRegistry(params.agentManager).live.get(
    finishWatcherKey(params.childAgentId, params.callerAgentId),
  );
  if (existing) {
    // A live watch already holds newer state than a journal entry.
    if (!params.resume) existing.refresh(params.requireParentOwnership ?? false);
    return;
  }
  startFinishWatcher(params);
}

function startFinishWatcher(params: SetupFinishNotificationParams): void {
  const { agentManager, agentStorage, childAgentId, callerAgentId, logger } = params;
  const resume = params.resume ?? null;
  // Do NOT treat an immediate "idle" as "finished" below: the agent may not have started yet
  // (streamAgent sets a pending run before transitioning to "running"). A resumed watch may find
  // its child unloaded; the subscription still sees it once it loads.
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (childSnapshot?.lifecycle === "closed" || (!childSnapshot && !resume)) return;
  const registry = finishWatchRegistry(agentManager);
  makeRoomForWatcher(registry);

  const key = finishWatcherKey(childAgentId, callerAgentId);
  const archiveOnFinish = resume ? resume.archiveOnFinish : archivesOnFinish(childSnapshot?.labels);
  let requireParentOwnership = params.requireParentOwnership ?? false;
  let finishOwed = resume ? resume.finishOwed : true;
  let lastReportHash = resume?.lastReportHash ?? null;
  let callerWaitsSince: number | null = finishOwed ? Date.now() : null;
  let hasSeenRunning = false;
  let stopped = false;
  let held = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let reportedReview: string | null = null;
  let reviewHandedOver = false;
  let notifiedErrorSinceRun = false;
  let callerReadsTurn = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();
  let lastProgressAt = Date.now();
  let stallNotified = false;
  const stallTimer = setInterval(checkStall, FINISH_WATCH_STALL_CHECK_MS);
  stallTimer.unref?.();

  const watcher: LiveFinishWatcher = {
    childAgentId,
    callerAgentId,
    refresh,
    holdsCallerUntil,
    recheckHold,
    evictableSince,
    end: endQuietly,
    callerReadsNextTurn: () => {
      callerReadsTurn = true;
    },
  };
  registry.live.set(key, watcher);
  if (callerWaitsSince !== null) registry.holdingCaller.add(watcher);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(stallTimer);
    clearHoldTimer();
    unsubscribe?.();
    if (registry.live.get(key) === watcher) registry.live.delete(key);
  }

  function journalState(): void {
    finishWatcherJournal?.addWatcher(childAgentId, callerAgentId, requireParentOwnership, {
      finishOwed,
      lastReportHash,
    });
  }

  /** The caller no longer waits on this watch: a caller held on it may report its own finish. */
  function releaseCaller(): void {
    if (callerWaitsSince === null) return;
    callerWaitsSince = null;
    registry.holdingCaller.delete(watcher);
    recheckHoldsOf(registry, callerAgentId);
  }

  function endQuietly(reason: string): void {
    if (stopped) return;
    logger.info({ childAgentId, callerAgentId, reason }, "finish_watch.ended");
    stop();
    finishWatcherJournal?.removeWatcher(childAgentId, callerAgentId);
    releaseCaller();
  }

  function refresh(nextRequireParentOwnership: boolean): void {
    if (stopped) return;
    const child = agentManager.getAgent(childAgentId);
    if (!child || child.lifecycle === "closed") {
      endQuietly("child-gone");
      return;
    }
    requireParentOwnership = nextRequireParentOwnership;
    finishOwed = true;
    reportedReview = null;
    reviewHandedOver = false;
    callerWaitsSince = Date.now();
    registry.holdingCaller.add(watcher);
    noteProgress();
    if (child.lifecycle === "running") hasSeenRunning = true;
    journalState();
    if (child.lifecycle === "error") {
      notifiedErrorSinceRun = false;
      notifyErrored();
    }
  }

  function holdsCallerUntil(): number | null {
    if (callerWaitsSince === null) return null;
    return Math.max(callerWaitsSince, lastProgressAt) + SUB_AGENT_HOLD_MAX_MS;
  }

  function evictableSince(): number | null {
    if (stopped || finishOwed || held || hasSeenRunning || callerWaitsSince !== null) return null;
    return lastProgressAt;
  }

  function noteProgress(): void {
    lastProgressAt = Date.now();
    stallNotified = false;
  }

  function checkStall(): void {
    if (stopped) return;
    if (evictableSince() !== null && Date.now() - lastProgressAt >= CONTINUED_WATCH_MAX_QUIET_MS) {
      endQuietly("quiet");
      return;
    }
    if (stallNotified) return;
    const child = agentManager.getAgent(childAgentId);
    // Only a run in progress can stall; an idle child holding wait_for waits has their deadlines,
    // and a permission request is already reported and waits on a person.
    if (!child || child.lifecycle !== "running" || child.pendingPermissions.size > 0) return;
    if (Date.now() - lastProgressAt < FINISH_WATCH_STALL_MS) return;
    stallNotified = true;
    notifySafely(STALL_NOTIFICATION_REASON, { terminal: false });
  }

  function clearHoldTimer(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function scheduleHoldRecheck(until: number | null): void {
    clearHoldTimer();
    if (until === null) return;
    holdTimer = setTimeout(
      () => {
        holdTimer = null;
        recheckHold();
      },
      Math.max(0, until - Date.now()) + 1,
    );
    holdTimer.unref?.();
  }

  function recheckHold(): void {
    if (stopped || !held) return;
    const child = agentManager.getAgent(childAgentId);
    // A child about to run (a sub-agent's notice was just sent to it) reports at that run's end.
    if (child && (child.lifecycle !== "idle" || agentManager.hasInFlightRun(childAgentId))) return;
    // An unloaded child is idle and held no wait (the idle unloader refuses one that does).
    handleIdle(child?.pendingBackgroundWaits ?? 0);
  }

  function isNewReport(message: string | null): message is string {
    const trimmed = message?.trim() ?? "";
    if (!trimmed || trimmed === WAIT_NOTED_REPLY) return false;
    return finishReportHash(message!) !== lastReportHash;
  }

  async function childBelongsToCaller(): Promise<boolean> {
    const record = await agentStorage.get(childAgentId);
    return getParentAgentIdFromLabels(record?.labels) === callerAgentId;
  }

  function enqueue(
    reason: FinishNotificationReason,
    task: () => Promise<void>,
    failure = "Failed to notify caller agent",
  ): void {
    notificationQueue = notificationQueue.then(task).catch((error) => {
      logger.error({ err: error, childAgentId, callerAgentId, reason }, failure);
    });
  }

  async function notify(
    reason: FinishNotificationReason,
    terminal: boolean,
    options: Pick<NotifySafelyOptions, "permissionRequest" | "archiveAfter"> & {
      message?: string | null;
    } = {},
  ): Promise<FinishNotificationDelivery> {
    const delivery = await deliverFinishNotification({
      agentManager,
      agentStorage,
      childAgentId,
      callerAgentId,
      // A turn nobody asked about is reported only to the child's own parent.
      requireParentOwnership: finishOwed ? requireParentOwnership : true,
      reason,
      permissionRequest: options.permissionRequest,
      archiveAfter: options.archiveAfter,
      lastAssistantMessage: options.message,
      logger,
    });
    if (
      reason === LEAD_REVIEW_NOTIFICATION_REASON &&
      (delivery === "delivered" || delivery === "caller-gone")
    ) {
      reviewHandedOver = true;
    }
    if (delivery === "shutting-down") return delivery;
    const unreachable = delivery === "caller-gone" || delivery === "not-owned";
    if (unreachable) {
      logger.info({ childAgentId, callerAgentId, reason, delivery }, "finish_watch.not_delivered");
    }
    if (terminal || unreachable) {
      stop();
      finishWatcherJournal?.removeWatcher(childAgentId, callerAgentId);
    }
    if (unreachable) releaseCaller();
    return delivery;
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    const terminal = options.terminal ?? true;
    if (terminal) stop();
    enqueue(reason, async () => {
      try {
        await notify(reason, terminal, options);
      } finally {
        if (CALLER_RELEASING_REASONS.has(reason)) releaseCaller();
      }
    });
  }

  // Local fork (delta 44): an errored child can still recover (restart recovery, quota resume, a
  // human prompt), so the error is reported once per run and the watch continues; the caller
  // hears about the later finish too. An archiveOnFinish child is archived after the error notice
  // instead (delta 103), so that notice ends the watch.
  function notifyErrored(): void {
    if (notifiedErrorSinceRun) return;
    notifiedErrorSinceRun = true;
    hasSeenRunning = false;
    held = false;
    clearHoldTimer();
    if (archiveOnFinish) {
      notifySafely("errored", { archiveAfter: true });
      return;
    }
    notifySafely("errored", { terminal: false });
  }

  /** Idle with waits or sub-agents pending: deliver a report that asks for review, once. */
  async function reportReviewIfAsked(): Promise<void> {
    const message = await agentManager.getLastAssistantMessage(childAgentId);
    if (stopped || !held || !asksForLeadReview(message) || message === reportedReview) return;
    if (!isNewReport(message)) return;
    reportedReview = message;
    enqueue(LEAD_REVIEW_NOTIFICATION_REASON, async () => {
      try {
        const delivery = await notify(LEAD_REVIEW_NOTIFICATION_REASON, false, { message });
        if (delivery === "delivered") {
          finishOwed = false;
          lastReportHash = finishReportHash(message);
          if (!stopped) journalState();
        }
      } finally {
        releaseCaller();
      }
    });
  }

  /** A turn ended with nothing pending: tell the caller when it is owed a finish or new report. */
  async function reportTurnEnd(): Promise<void> {
    if (stopped) return;
    // A newer turn already started; its own end is reported.
    if (agentManager.getAgent(childAgentId)?.lifecycle === "running") return;
    const message = await agentManager.getLastAssistantMessage(childAgentId);
    if (stopped) return;
    const readByCaller = callerReadsTurn;
    callerReadsTurn = false;
    if (readByCaller && !finishOwed) {
      lastReportHash = message === null ? null : finishReportHash(message);
      journalState();
      return;
    }
    if (!finishOwed && !isNewReport(message)) {
      logger.debug({ childAgentId, callerAgentId }, "finish_watch.repeat_suppressed");
      return;
    }
    let delivery: FinishNotificationDelivery;
    try {
      delivery = await notify("finished", false, { message });
    } finally {
      // On a failed delivery the finish stays owed and the next turn end retries it.
      releaseCaller();
    }
    if (delivery !== "delivered") return;
    finishOwed = false;
    lastReportHash = message === null ? null : finishReportHash(message);
    if (stopped) return;
    if (await childBelongsToCaller()) {
      journalState();
      return;
    }
    // A follow-up to an agent the caller does not own reports that one turn, as before delta 106.
    stop();
    finishWatcherJournal?.removeWatcher(childAgentId, callerAgentId);
  }

  /** archiveOnFinish (delta 103): the first finish is the last notice, then the child is archived. */
  function finishArchiveOnFinishChild(): void {
    if (stopped) return;
    stop();
    if (reportedReview === null) {
      enqueue("finished", async () => {
        try {
          await notify("finished", true, { archiveAfter: true });
        } finally {
          releaseCaller();
        }
      });
      return;
    }
    // After a review notice: deliver the final idle only when the child said something new.
    enqueue("finished", async () => {
      try {
        const message = await agentManager.getLastAssistantMessage(childAgentId);
        if (isNewReport(message)) {
          await notify("finished", true, { archiveAfter: true, message });
          return;
        }
        finishWatcherJournal?.removeWatcher(childAgentId, callerAgentId);
        // The review notice already carried this report; archive once it has been handed over.
        if (reviewHandedOver) {
          await archiveFinishedChild({ agentManager, agentStorage, childAgentId, logger });
        }
      } finally {
        releaseCaller();
      }
    });
  }

  function handleIdle(pendingBackgroundWaits: number): void {
    // Local fork: a child that ended its turn to wait on background waits (delta 29) or on
    // sub-agents it watches (delta 106) is not finished; the idle after its last wake turn is.
    const subAgents = subAgentHold(registry, childAgentId, Date.now());
    if (pendingBackgroundWaits > 0 || subAgents.count > 0) {
      if (!held) {
        logger.debug(
          { childAgentId, callerAgentId, pendingBackgroundWaits, subAgents: subAgents.count },
          "finish_watch.held",
        );
      }
      held = true;
      scheduleHoldRecheck(subAgents.until);
      void reportReviewIfAsked().catch((error) => {
        logger.error({ err: error, childAgentId, callerAgentId }, "Failed to read child report");
      });
      return;
    }
    held = false;
    clearHoldTimer();
    hasSeenRunning = false;
    if (archiveOnFinish) {
      finishArchiveOnFinishChild();
      return;
    }
    enqueue("finished", reportTurnEnd);
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }
      noteProgress();

      if (event.type === "agent_state") {
        for (const requestId of notifiedPermissionRequestIds) {
          if (!event.agent.pendingPermissions.has(requestId)) {
            notifiedPermissionRequestIds.delete(requestId);
          }
        }
        if (event.agent.lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) {
            hasSeenRunning = true;
            notifiedErrorSinceRun = false;
          }
          held = false;
          clearHoldTimer();
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifyErrored();
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          handleIdle(event.agent.pendingBackgroundWaits ?? 0);
          return;
        }
        if (event.agent.lifecycle === "closed") {
          // Archive, close, or workspace teardown: report it only to a caller still waiting.
          if (finishOwed || held) {
            notifySafely("was closed");
          } else {
            endQuietly("child-closed");
          }
          return;
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  journalState();
  // Catch a child that started running before the subscription (see the note above).
  if (childSnapshot?.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot?.lifecycle === "error") {
    notifyErrored();
  }
}
