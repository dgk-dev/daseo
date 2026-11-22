import path from "node:path";
import type pino from "pino";
import type { TimelineCompactionResult } from "./file-backed-agent-timeline-store.js";
import {
  listTimelineDirectory,
  looseRowFileName,
  sumAllocatedBytes,
} from "./timeline-row-files.js";

/**
 * Daseo delta 146: compacts archived agents' timelines in the background, one
 * agent at a time with a pause between agents, so millions of unlinks never
 * hold the daemon. Off unless PASEO_TIMELINE_COMPACTION turns it on; each run
 * stops after `maxAgentsPerRun` agents, oldest archive first.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** An agent archived more recently than this is left as it is. */
export const TIMELINE_COMPACTION_MIN_ARCHIVED_AGE_MS = 7 * DAY_MS;
/** Fewer loose rows than this is not worth a bundle rewrite. */
export const TIMELINE_COMPACTION_MIN_LOOSE_FILES = 2;
/** Startup (providers, relay, History search's first pass) settles before the first run. */
export const TIMELINE_COMPACTION_START_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_PAUSE_BETWEEN_AGENTS_MS = 250;

export type TimelineCompactionMode = "compact" | "dry-run";

export interface TimelineCompactionSettings {
  mode: TimelineCompactionMode;
  maxAgentsPerRun: number;
  /** Null runs once per daemon start. */
  intervalMs: number | null;
}

export interface CompactionAgentRecord {
  id: string;
  archivedAt?: string | null;
}

export interface TimelineCompactionRunSummary {
  mode: TimelineCompactionMode;
  /** Agents that met every rule and were compacted, or would have been in a dry run. */
  agents: number;
  failed: number;
  looseFiles: number;
  rows: number;
  allocatedBytesBefore: number;
  /** Zero in a dry run: nothing was written. */
  allocatedBytesAfter: number;
  durationMs: number;
  stopped: boolean;
}

export interface TimelineCompactionSweeperOptions {
  store: { compactTimeline(agentId: string): Promise<TimelineCompactionResult> };
  timelinesDir: string;
  listAgentRecords: () => Promise<readonly CompactionAgentRecord[]>;
  getAgentRecord: (agentId: string) => Promise<CompactionAgentRecord | null>;
  /** True while the agent manager holds the agent. */
  isAgentLoaded: (agentId: string) => boolean;
  settings: TimelineCompactionSettings;
  logger: pino.Logger;
  now?: () => number;
  pauseBetweenAgentsMs?: number;
}

function archivedAtMs(record: CompactionAgentRecord): number | null {
  if (!record.archivedAt) return null;
  const parsed = Date.parse(record.archivedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export class TimelineCompactionSweeper {
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private readonly pauseMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<TimelineCompactionRunSummary> | null = null;
  private stopped = false;

  constructor(private readonly options: TimelineCompactionSweeperOptions) {
    this.logger = options.logger.child({ module: "timeline-compaction" });
    this.now = options.now ?? Date.now;
    this.pauseMs = options.pauseBetweenAgentsMs ?? DEFAULT_PAUSE_BETWEEN_AGENTS_MS;
  }

  start(options: { delayMs?: number } = {}): void {
    if (this.stopped || this.timer) return;
    this.schedule(options.delayMs ?? TIMELINE_COMPACTION_START_DELAY_MS);
  }

  /** Waits for the agent in progress to finish; no further agent starts. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass. Exposed for tests and the real-data check. */
  runOnce(): Promise<TimelineCompactionRunSummary> {
    if (this.running) return this.running;
    const run = this.sweep().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => this.logger.warn({ err: error }, "Timeline compaction run failed"))
        .finally(() => {
          const intervalMs = this.options.settings.intervalMs;
          if (!this.stopped && intervalMs !== null) this.schedule(intervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Oldest archive first; only agents archived long enough ago. */
  private async candidates(): Promise<string[]> {
    const cutoff = this.now() - TIMELINE_COMPACTION_MIN_ARCHIVED_AGE_MS;
    const records = await this.options.listAgentRecords();
    return records
      .flatMap((record) => {
        const archived = archivedAtMs(record);
        return archived !== null && archived <= cutoff ? [{ id: record.id, archived }] : [];
      })
      .sort((left, right) => left.archived - right.archived || left.id.localeCompare(right.id))
      .map((candidate) => candidate.id);
  }

  /** Re-checked right before each agent: the record and the manager may have changed. */
  private async isEligible(agentId: string): Promise<{ looseFiles: string[] } | null> {
    if (this.options.isAgentLoaded(agentId)) return null;
    const record = await this.options.getAgentRecord(agentId);
    const archived = record ? archivedAtMs(record) : null;
    if (archived === null || archived > this.now() - TIMELINE_COMPACTION_MIN_ARCHIVED_AGE_MS) {
      return null;
    }
    let looseSeqs: number[];
    try {
      ({ looseSeqs } = await listTimelineDirectory(path.join(this.options.timelinesDir, agentId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (looseSeqs.length < TIMELINE_COMPACTION_MIN_LOOSE_FILES) return null;
    return { looseFiles: looseSeqs.map(looseRowFileName) };
  }

  private async sweep(): Promise<TimelineCompactionRunSummary> {
    const { mode, maxAgentsPerRun } = this.options.settings;
    const startedAt = this.now();
    const summary: TimelineCompactionRunSummary = {
      mode,
      agents: 0,
      failed: 0,
      looseFiles: 0,
      rows: 0,
      allocatedBytesBefore: 0,
      allocatedBytesAfter: 0,
      durationMs: 0,
      stopped: false,
    };
    for (const agentId of await this.candidates()) {
      if (summary.agents + summary.failed >= maxAgentsPerRun) break;
      if (this.stopped) {
        summary.stopped = true;
        break;
      }
      let eligible: { looseFiles: string[] } | null;
      try {
        eligible = await this.isEligible(agentId);
      } catch (error) {
        summary.failed += 1;
        this.logger.warn(
          { err: error, agentId },
          "Timeline compaction skipped an unreadable agent",
        );
        continue;
      }
      if (!eligible) continue;

      if (mode === "dry-run") {
        const directory = path.join(this.options.timelinesDir, agentId);
        summary.agents += 1;
        summary.looseFiles += eligible.looseFiles.length;
        summary.allocatedBytesBefore += await sumAllocatedBytes(
          eligible.looseFiles.map((name) => path.join(directory, name)),
        );
        continue;
      }

      try {
        const result = await this.options.store.compactTimeline(agentId);
        if (result.status === "compacted") {
          summary.agents += 1;
          summary.looseFiles += result.looseFilesRemoved;
          summary.rows += result.rows;
          summary.allocatedBytesBefore += result.allocatedBytesBefore;
          summary.allocatedBytesAfter += result.allocatedBytesAfter;
        }
      } catch (error) {
        // The store deletes nothing when a timeline does not load cleanly.
        summary.failed += 1;
        this.logger.warn({ err: error, agentId }, "Timeline compaction left an agent unchanged");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.pauseMs);
      });
    }
    summary.durationMs = this.now() - startedAt;
    this.logger.info(
      {
        ...summary,
        reclaimedBytes:
          mode === "dry-run" ? 0 : summary.allocatedBytesBefore - summary.allocatedBytesAfter,
      },
      mode === "dry-run" ? "Timeline compaction dry run" : "Timeline compaction run",
    );
    return summary;
  }
}

export interface TimelineCompactionHandle {
  stop(): Promise<void>;
}

/** Starts the sweeper when settings turn it on; otherwise a handle that does nothing. */
export function startTimelineCompactionSweeper(
  options: Omit<TimelineCompactionSweeperOptions, "settings"> & {
    settings: TimelineCompactionSettings | null | undefined;
  },
): TimelineCompactionHandle {
  const { settings } = options;
  if (!settings) return { stop: async () => undefined };
  const sweeper = new TimelineCompactionSweeper({ ...options, settings });
  sweeper.start();
  return sweeper;
}
