// Local fork (DASEO.md delta 44): nothing an agent is waiting on may be lost silently.
//
// A Pi agent's wait_for waits live in its Pi process and a child's notify-on-finish watcher lives
// in this daemon's memory, so a daemon restart (Daseo activation, crash, reboot), a session reload,
// or a Pi death between turns used to drop them without a word: the agent sat idle "waiting"
// until a human prompted it (2026-10-01..16: 14 lost waits, 2 lost child notifications, all on
// activations). This module journals what would be lost to `$PASEO_HOME/restart-recovery.json`,
// and after the next start it prompts each affected agent to re-check and continue, re-arms the
// child watchers, and delivers a finish notification that was cut off by the shutdown.
//
// Policy: a notice tells the agent to verify what took effect before re-running anything, because
// a wait's command (a push, build, deploy) dies with the process. One automatic notice per agent
// per RECOVERY_COOLDOWN_MS, so a crash loop cannot become a prompt loop. A journal older than
// JOURNAL_MAX_AGE_MS (daemon down for days) is dropped instead of waking agents on stale state.

import { existsSync, promises as fs, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";

export const RESTART_RECOVERY_FILE = "restart-recovery.json";
export const JOURNAL_MAX_AGE_MS = 12 * 60 * 60_000;
export const RECOVERY_COOLDOWN_MS = 10 * 60_000;
const WRITE_DEBOUNCE_MS = 300;

export interface JournalAgentEntry {
  /** wait_for waits that a restart would kill. */
  waits?: { pending: number; labels: string[] };
  /** A turn was running; a restart cuts it off. */
  running?: boolean;
  updatedAt: string;
}

export interface JournalWatcherEntry {
  callerAgentId: string;
  requireParentOwnership: boolean;
  createdAt: string;
}

export interface RecoveryJournal {
  version: 1;
  writtenAt: string;
  agents: Record<string, JournalAgentEntry>;
  watchers: Record<string, JournalWatcherEntry>;
  /** Last automatic recovery notice per agent, carried across restarts for the cooldown. */
  recoveredAt: Record<string, string>;
}

export interface AgentWaitState {
  agentId: string;
  pendingBackgroundWaits: number;
  backgroundWaitLabels: string[];
  running: boolean;
  closed: boolean;
}

export type RecoveryCause = "daemon_restart" | "reload" | "pi_exit";

export interface RecoveryNotice {
  agentId: string;
  cause: RecoveryCause;
  lostWaits?: { pending: number; labels: string[] };
  turnInterrupted?: boolean;
  /** When the loss happened (for daemon restarts: the journal's last write). */
  at: Date;
}

function emptyJournal(now: Date): RecoveryJournal {
  return { version: 1, writtenAt: now.toISOString(), agents: {}, watchers: {}, recoveredAt: {} };
}

function parseJournal(value: unknown): RecoveryJournal | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<RecoveryJournal>;
  if (raw.version !== 1 || typeof raw.writtenAt !== "string") return null;
  return {
    version: 1,
    writtenAt: raw.writtenAt,
    agents: raw.agents && typeof raw.agents === "object" ? raw.agents : {},
    watchers: raw.watchers && typeof raw.watchers === "object" ? raw.watchers : {},
    recoveredAt: raw.recoveredAt && typeof raw.recoveredAt === "object" ? raw.recoveredAt : {},
  };
}

/**
 * The live journal. Changes are written debounced; `freeze()` writes the final state
 * synchronously at shutdown and ignores everything after it, so closing every agent during
 * shutdown does not erase what the restart is about to lose.
 */
export class RestartRecoveryJournal {
  readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private journal: RecoveryJournal;
  private frozen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: { paseoHome: string; logger: Logger; now?: () => Date }) {
    this.filePath = path.join(options.paseoHome, RESTART_RECOVERY_FILE);
    this.logger = options.logger.child({ module: "agent", component: "restart-recovery" });
    this.now = options.now ?? (() => new Date());
    this.journal = emptyJournal(this.now());
  }

  /**
   * Read the journal the previous daemon left and move it aside, so it is processed at most once
   * even if this start crashes. Keeps the cooldown stamps for the new journal.
   */
  async takePrevious(): Promise<RecoveryJournal | null> {
    if (!existsSync(this.filePath)) return null;
    let previous: RecoveryJournal | null = null;
    try {
      previous = parseJournal(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      this.logger.warn({ err: error }, "restart_recovery.journal_unreadable");
    }
    try {
      renameSync(this.filePath, `${this.filePath}.processed`);
    } catch {
      // Best effort; a missing file is fine.
    }
    if (previous) this.journal.recoveredAt = { ...previous.recoveredAt };
    return previous;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  noteAgentState(state: AgentWaitState): void {
    if (this.frozen) return;
    const current = this.journal.agents[state.agentId];
    if (state.closed) {
      // Closed on purpose while the daemon keeps running (archive, idle unload, user close).
      if (current) {
        delete this.journal.agents[state.agentId];
        this.schedule();
      }
      return;
    }
    const waits =
      state.pendingBackgroundWaits > 0
        ? { pending: state.pendingBackgroundWaits, labels: [...state.backgroundWaitLabels] }
        : undefined;
    if (!waits && !state.running) {
      if (current) {
        delete this.journal.agents[state.agentId];
        this.schedule();
      }
      return;
    }
    const next: JournalAgentEntry = {
      ...(waits ? { waits } : {}),
      ...(state.running ? { running: true } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (
      current &&
      current.running === next.running &&
      JSON.stringify(current.waits) === JSON.stringify(next.waits)
    ) {
      return;
    }
    this.journal.agents[state.agentId] = next;
    this.schedule();
  }

  addWatcher(childAgentId: string, callerAgentId: string, requireParentOwnership: boolean): void {
    if (this.frozen) return;
    this.journal.watchers[childAgentId] = {
      callerAgentId,
      requireParentOwnership,
      createdAt: this.now().toISOString(),
    };
    this.schedule();
  }

  removeWatcher(childAgentId: string, callerAgentId: string): void {
    if (this.frozen) return;
    if (this.journal.watchers[childAgentId]?.callerAgentId !== callerAgentId) return;
    delete this.journal.watchers[childAgentId];
    this.schedule();
  }

  /** Returns false while the cooldown since this agent's last automatic notice has not elapsed. */
  claimRecovery(agentId: string): boolean {
    const last = this.journal.recoveredAt[agentId];
    const now = this.now();
    if (last && now.getTime() - Date.parse(last) < RECOVERY_COOLDOWN_MS) return false;
    this.journal.recoveredAt[agentId] = now.toISOString();
    for (const [id, stamp] of Object.entries(this.journal.recoveredAt)) {
      if (now.getTime() - Date.parse(stamp) > JOURNAL_MAX_AGE_MS)
        delete this.journal.recoveredAt[id];
    }
    if (!this.frozen) this.schedule();
    return true;
  }

  /** Final synchronous write at shutdown, from the live agent list; later changes are ignored. */
  freeze(states: AgentWaitState[]): void {
    if (this.frozen) return;
    for (const state of states) this.noteAgentState(state);
    this.frozen = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.journal.writtenAt = this.now().toISOString();
    try {
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tempPath, JSON.stringify(this.journal, null, 2), "utf8");
      renameSync(tempPath, this.filePath);
    } catch (error) {
      this.logger.error({ err: error }, "restart_recovery.freeze_write_failed");
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.write();
    }
    await this.writing;
  }

  private schedule(): void {
    if (this.frozen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, WRITE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private write(): void {
    if (this.frozen) return;
    this.journal.writtenAt = this.now().toISOString();
    const snapshot = JSON.parse(JSON.stringify(this.journal)) as RecoveryJournal;
    this.writing = this.writing
      .then(() => writeJsonFileAtomic(this.filePath, snapshot))
      .catch((error) => {
        this.logger.warn({ err: error }, "restart_recovery.write_failed");
      });
  }
}

function formatClock(at: Date): string {
  return at.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16) + " KST";
}

const CAUSE_TEXT: Record<RecoveryCause, string> = {
  daemon_restart: "Daseo restarted",
  reload: "this agent's session was reloaded",
  pi_exit: "this agent's Pi process exited unexpectedly",
};

/** The prompt body an affected agent receives. */
export function formatRecoveryNotice(notice: RecoveryNotice): string {
  const lines = [`Recovery notice: ${CAUSE_TEXT[notice.cause]} at ${formatClock(notice.at)}.`];
  if (notice.turnInterrupted) {
    lines.push(
      "Your turn was running and was cut off; tool calls in flight may or may not have taken effect.",
    );
  }
  if (notice.lostWaits && notice.lostWaits.pending > 0) {
    const labels = notice.lostWaits.labels.filter((label) => label.length > 0);
    lines.push(
      `${notice.lostWaits.pending} background wait(s) you registered with wait_for were stopped and will never wake you${
        labels.length > 0 ? `: ${labels.map((label) => JSON.stringify(label)).join(", ")}` : ""
      }. A command a wait was running (a build, push, deploy, copy) was killed mid-run.`,
    );
  }
  lines.push(
    "Check what actually happened (git status and log, deploy status, output files, remote state) before re-running anything, then re-register only the waits you still need and continue your task.",
    "This notice is not a new request. If your task was already complete and nothing needs re-checking, reply with exactly [wait noted].",
  );
  return lines.join(" ");
}
