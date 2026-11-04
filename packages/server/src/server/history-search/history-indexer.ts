import type pino from "pino";
import type { HistoryIndexStore } from "./history-index-store.js";
import { readPiSessionFileMark, readPiSessionMessages } from "./pi-session-message-reader.js";
import {
  readTimelineEpoch,
  readTimelineMessages,
  timelineDirectory,
} from "./timeline-message-reader.js";

/**
 * Keeps the History search index in step with the sessions History lists.
 *
 * Only root sessions are indexed: a sub-agent's text is not History's to show
 * and is never attributed to its parent. The first build reads every timeline
 * once in the background; afterwards each committed timeline change syncs
 * just that agent, reading only the rows after the last one indexed. Every
 * sync re-derives the truth from disk (record, timeline epoch, session file),
 * so a reset timeline, a deleted agent, or a session that gained a timeline
 * all land in the same code path.
 */

export interface IndexableAgent {
  id: string;
  /** Pi session file for agents whose text predates Paseo timelines. */
  piSessionFile: string | null;
}

export interface HistoryIndexerStatus {
  state: "indexing" | "ready";
  indexedSessions: number;
  totalSessions: number;
}

export interface HistoryIndexerOptions {
  store: HistoryIndexStore;
  timelinesDir: string;
  /** Every root session History lists (not internal, not created by an agent). */
  listRootAgents: () => Promise<IndexableAgent[]>;
  /** The agent if it is a root session History lists, otherwise null. */
  resolveRootAgent: (agentId: string) => Promise<IndexableAgent | null>;
  logger: pino.Logger;
  /** Called after a session's indexed text changed or was removed. */
  onSessionChanged?: (agentId: string) => void;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 1_500;

export class HistoryIndexer {
  private readonly store: HistoryIndexStore;
  private readonly timelinesDir: string;
  private readonly listRootAgents: () => Promise<IndexableAgent[]>;
  private readonly resolveRootAgent: (agentId: string) => Promise<IndexableAgent | null>;
  private readonly logger: pino.Logger;
  private readonly onSessionChanged: (agentId: string) => void;
  private readonly debounceMs: number;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Agents whose timeline changed while the daemon runs; synced first. */
  private readonly priorityQueue = new Set<string>();
  private readonly backfillQueue = new Map<string, IndexableAgent>();
  private readonly rootIds = new Set<string>();
  private backfillDone = false;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(options: HistoryIndexerOptions) {
    this.store = options.store;
    this.timelinesDir = options.timelinesDir;
    this.listRootAgents = options.listRootAgents;
    this.resolveRootAgent = options.resolveRootAgent;
    this.logger = options.logger.child({ component: "history-indexer" });
    this.onSessionChanged = options.onSessionChanged ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Starts the background pass over every root session. */
  async start(): Promise<void> {
    const roots = await this.listRootAgents();
    const rootIds = new Set(roots.map((agent) => agent.id));
    for (const id of rootIds) this.rootIds.add(id);
    for (const session of this.store.listSessions()) {
      if (!rootIds.has(session.agentId)) {
        this.store.deleteSession(session.agentId);
        this.onSessionChanged(session.agentId);
      }
    }
    for (const agent of roots) this.backfillQueue.set(agent.id, agent);
    this.logger.info({ sessions: roots.length }, "History index pass started");
    const startedAt = Date.now();
    await this.drain();
    this.backfillDone = true;
    this.logger.info(
      { sessions: roots.length, elapsedMs: Date.now() - startedAt },
      "History index pass finished",
    );
  }

  /** A committed timeline row was written or the timeline was deleted. */
  notifyTimelineChanged(agentId: string): void {
    if (this.stopped) return;
    const existing = this.debounceTimers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(agentId);
      this.priorityQueue.add(agentId);
      void this.drain();
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(agentId, timer);
  }

  /**
   * The agent's record changed. Only a change in whether it is a root session
   * needs a sync (a detached sub-agent becomes one; a new agent appears before
   * its first timeline row); ordinary snapshot writes are skipped here.
   */
  notifyAgentRecordChanged(agentId: string, agent: IndexableAgent | null): void {
    if ((agent !== null) === this.rootIds.has(agentId)) return;
    this.notifyTimelineChanged(agentId);
  }

  status(): HistoryIndexerStatus {
    const indexed = this.store
      .listSessions()
      .filter((session) => this.rootIds.has(session.agentId));
    return {
      state: this.backfillDone ? "ready" : "indexing",
      indexedSessions: indexed.length,
      totalSessions: this.rootIds.size,
    };
  }

  /** Resolves once queued work is done; used by tests and shutdown. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.priorityQueue.clear();
    this.backfillQueue.clear();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.runQueue().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async runQueue(): Promise<void> {
    while (!this.stopped) {
      const next = this.takeNext();
      if (!next) return;
      try {
        await this.syncAgent(next);
      } catch (error) {
        this.logger.warn({ err: error, agentId: next.id }, "History index sync failed");
      }
    }
  }

  private takeNext(): { id: string; known: IndexableAgent | null } | null {
    const priority = this.priorityQueue.values().next();
    if (!priority.done) {
      this.priorityQueue.delete(priority.value);
      this.backfillQueue.delete(priority.value);
      return { id: priority.value, known: null };
    }
    const backfill = this.backfillQueue.entries().next();
    if (!backfill.done) {
      const [id, agent] = backfill.value;
      this.backfillQueue.delete(id);
      return { id, known: agent };
    }
    return null;
  }

  private async syncAgent(target: { id: string; known: IndexableAgent | null }): Promise<void> {
    const agent = target.known ?? (await this.resolveRootAgent(target.id));
    if (!agent) {
      this.rootIds.delete(target.id);
      if (this.store.getSession(target.id)) {
        this.store.deleteSession(target.id);
        this.onSessionChanged(target.id);
      }
      return;
    }
    this.rootIds.add(agent.id);
    if (await this.syncFromTimeline(agent.id)) return;
    if (agent.piSessionFile && (await this.syncFromPiSessionFile(agent.id, agent.piSessionFile))) {
      return;
    }
    const existing = this.store.getSession(agent.id);
    if (existing?.source === "none") return;
    this.store.replaceSession({
      session: {
        agentId: agent.id,
        source: "none",
        sourceMark: "",
        indexedSeq: 0,
        lastAnchorSeq: null,
        tailAssistantSeq: null,
      },
      messages: [],
    });
    if (existing) this.onSessionChanged(agent.id);
  }

  /** False when the agent has no timeline. */
  private async syncFromTimeline(agentId: string): Promise<boolean> {
    const directory = timelineDirectory(this.timelinesDir, agentId);
    const epoch = await readTimelineEpoch(directory);
    if (!epoch) return false;
    const existing = this.store.getSession(agentId);
    if (!existing || existing.source !== "timeline" || existing.sourceMark !== epoch) {
      const batch = await readTimelineMessages({
        directory,
        afterSeq: 0,
        state: { anchorSeq: null, tailAssistantSeq: null },
      });
      this.store.replaceSession({
        session: {
          agentId,
          source: "timeline",
          sourceMark: epoch,
          indexedSeq: batch.maxSeq,
          lastAnchorSeq: batch.state.anchorSeq,
          tailAssistantSeq: batch.state.tailAssistantSeq,
        },
        messages: batch.messages,
      });
      this.onSessionChanged(agentId);
      return true;
    }
    const batch = await readTimelineMessages({
      directory,
      afterSeq: existing.indexedSeq,
      state: { anchorSeq: existing.lastAnchorSeq, tailAssistantSeq: existing.tailAssistantSeq },
    });
    if (batch.maxSeq > existing.indexedSeq) {
      this.store.appendMessages({
        agentId,
        indexedSeq: batch.maxSeq,
        lastAnchorSeq: batch.state.anchorSeq,
        tailAssistantSeq: batch.state.tailAssistantSeq,
        continuationText: batch.continuationText,
        messages: batch.messages,
      });
      if (batch.messages.length > 0 || batch.continuationText) this.onSessionChanged(agentId);
    }
    return true;
  }

  /** False when the session file is missing. */
  private async syncFromPiSessionFile(agentId: string, filePath: string): Promise<boolean> {
    const mark = await readPiSessionFileMark(filePath);
    if (!mark) return false;
    const existing = this.store.getSession(agentId);
    if (existing?.source === "pi-file" && existing.sourceMark === mark) return true;
    const messages = await readPiSessionMessages(filePath);
    this.store.replaceSession({
      session: {
        agentId,
        source: "pi-file",
        sourceMark: mark,
        indexedSeq: 0,
        lastAnchorSeq: null,
        tailAssistantSeq: null,
      },
      messages,
    });
    this.onSessionChanged(agentId);
    return true;
  }
}
