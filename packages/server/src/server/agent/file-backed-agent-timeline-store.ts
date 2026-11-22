import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { lastAssistantRun } from "@getpaseo/protocol/wait-noted";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import {
  allocatedBytes,
  looseRowFileName,
  readBundleLines,
  listTimelineDirectory,
  readLooseRowText,
  readRawTimelineRows,
  type RawTimelineRow,
  sumAllocatedBytes,
  TIMELINE_BUNDLE_FILE,
  TIMELINE_BUNDLE_TEMP_FILE,
} from "./timeline-row-files.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const STORE_VERSION = 1;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Bundle bytes buffered before each write while compacting. */
const COMPACTION_WRITE_CHUNK_CHARS = 1 << 20;
/** Loose files unlinked concurrently per batch; the event loop gets a turn between batches. */
const COMPACTION_UNLINK_BATCH = 32;

const PersistedTimelineStateSchema = z.object({
  version: z.literal(STORE_VERSION),
  epoch: z.string().min(1),
  nextSeq: z.number().int().positive(),
});

const PersistedTimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

interface CachedTimelineState {
  epoch: string;
  nextSeq: number;
  rows: AgentTimelineRow[];
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: { ...row.item } } as AgentTimelineRow;
}

function assertSafeAgentId(agentId: string): void {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Unsafe agent timeline id '${agentId}'`);
  }
}

export type TimelineCompactionResult =
  | {
      status: "compacted";
      rows: number;
      looseFilesRemoved: number;
      /** Disk blocks held by the loose files and old bundle before, and by the new bundle after. */
      allocatedBytesBefore: number;
      allocatedBytesAfter: number;
    }
  | { status: "skipped"; reason: "no-timeline" | "no-loose-rows" };

export type TimelineExpansionResult =
  | { status: "expanded"; rows: number; looseFilesWritten: number }
  | { status: "skipped"; reason: "no-timeline" | "no-bundle" };

export class TimelineExpansionVerifyError extends Error {
  constructor(agentId: string, detail: string) {
    super(`Loose rows for '${agentId}' did not read back as the bundle held them: ${detail}`);
    this.name = "TimelineExpansionVerifyError";
  }
}

export class TimelineCompactionVerifyError extends Error {
  constructor(agentId: string, detail: string) {
    super(`Timeline bundle for '${agentId}' did not read back as written: ${detail}`);
    this.name = "TimelineCompactionVerifyError";
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows cannot open or fsync a directory; the rename is still atomic there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EBADF") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `writeFileAtomic` plus an fsync before the rename: the bundle is removed after these land. */
async function writeDurableFile(filePath: string, text: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(tempPath, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  ensurePrivateFile(filePath);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FileBackedAgentTimelineStore implements AgentTimelineStore {
  private readonly cache = new Map<string, CachedTimelineState>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly committedChangeListeners = new Set<(agentId: string) => void>();

  constructor(private readonly baseDir: string) {
    ensurePrivateDirectory(baseDir);
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    let result: AgentTimelineRow | null = null;
    await this.queueMutation(agentId, async (state) => {
      const row: AgentTimelineRow = {
        seq: state.nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
      };
      state.nextSeq += 1;
      state.rows.push(row);
      await this.writeRow(agentId, row);
      await this.writeState(agentId, state);
      result = cloneRow(row);
    });
    if (!result) throw new Error(`Failed to append timeline row for '${agentId}'`);
    this.notifyCommittedChange(agentId);
    return result;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const state = await this.load(agentId);
    const memory = new InMemoryAgentTimelineStore();
    memory.initialize(agentId, {
      rows: state.rows,
      epoch: state.epoch,
      nextSeq: state.nextSeq,
    });
    return memory.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const state = await this.load(agentId);
    return state.rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const state = await this.load(agentId);
    return state.rows.map(cloneRow);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const state = await this.load(agentId);
    return state.rows.at(-1)?.item ?? null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const state = await this.load(agentId);
    return (
      lastAssistantRun(
        state.rows.length,
        (index) => state.rows[index]?.item,
        (item) => (item.type === "assistant_message" ? item.text : null),
      )?.text ?? null
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    // On the agent's queue, so a compaction never reads a half-removed directory
    // and writes a bundle back into it. Removes rows.jsonl and any leftover temp.
    await this.runExclusive(agentId, async () => {
      this.cache.delete(agentId);
      await fs.rm(this.agentDirectory(agentId), { recursive: true, force: true });
    });
    this.notifyCommittedChange(agentId);
  }

  /**
   * Daseo delta 146: moves every committed row of one agent into `rows.jsonl`
   * and removes the loose files it read. Rows, epoch, and nextSeq do not change,
   * so the cache stays valid and no committed-change listener fires. The bundle
   * is written to a temp file, fsynced, read back and compared line by line, and
   * only then renamed over the old bundle; loose files are unlinked last. A crash
   * at any point leaves a directory every loader reads the same rows from.
   * Throws when the timeline does not load cleanly; nothing is deleted then.
   */
  async compactTimeline(agentId: string): Promise<TimelineCompactionResult> {
    return this.runExclusive(agentId, () => this.compactTimelineNow(agentId));
  }

  /**
   * Daseo delta 146 rollback: the inverse of `compactTimeline`, for going back to
   * a daemon that reads loose row files only. Writes a loose file for every
   * bundled row that has none, byte for byte the format `writeRow` uses, each
   * one fsynced; re-reads the loose files alone and compares them with what was
   * loaded; removes `rows.jsonl` last. Loose overlays are kept as they are. A
   * crash leaves the bundle plus identical loose files, which load the same rows,
   * and running it again finishes. Throws when the timeline does not load
   * cleanly; nothing is removed then.
   */
  async expandTimeline(agentId: string): Promise<TimelineExpansionResult> {
    return this.runExclusive(agentId, () => this.expandTimelineNow(agentId));
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.queueMutation(agentId, async (state) => {
      const bySeq = new Map(state.rows.map((row) => [row.seq, row]));
      for (const candidate of [...rows].sort((left, right) => left.seq - right.seq)) {
        const row = PersistedTimelineRowSchema.parse(candidate);
        bySeq.set(row.seq, cloneRow(row));
        await this.writeRow(agentId, row);
      }
      state.rows = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
      state.nextSeq = Math.max(state.nextSeq, (state.rows.at(-1)?.seq ?? 0) + 1);
      await this.writeState(agentId, state);
    });
    this.notifyCommittedChange(agentId);
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.queueMutation(agentId, async (state) => {
      const parsed = PersistedTimelineRowSchema.parse(row);
      const index = state.rows.findIndex((candidate) => candidate.seq === parsed.seq);
      if (index < 0) {
        throw new Error(`Cannot update missing timeline row ${parsed.seq} for '${agentId}'`);
      }
      state.rows[index] = cloneRow(parsed);
      await this.writeRow(agentId, parsed);
    });
  }

  /**
   * Daseo delta 79: called after committed rows reach disk or the timeline is
   * deleted, so derived indexes (History search) can catch up on that agent
   * alone. Row enrichment (`updateCommittedRow`) does not notify; it never
   * changes message text.
   */
  onCommittedChange(listener: (agentId: string) => void): () => void {
    this.committedChangeListeners.add(listener);
    return () => {
      this.committedChangeListeners.delete(listener);
    };
  }

  private notifyCommittedChange(agentId: string): void {
    for (const listener of this.committedChangeListeners) {
      try {
        listener(agentId);
      } catch {
        // A derived index must never fail a timeline write.
      }
    }
  }

  private async queueMutation(
    agentId: string,
    mutation: (state: CachedTimelineState) => Promise<void>,
  ): Promise<void> {
    await this.runExclusive(agentId, async () => {
      const state = await this.load(agentId);
      await mutation(state);
    });
  }

  /** Runs `task` after every earlier task of this agent settles. Enqueues synchronously. */
  private runExclusive<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    assertSafeAgentId(agentId);
    const previous = this.mutationTails.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tracked: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    const cleanup = tracked.finally(() => {
      if (this.mutationTails.get(agentId) === cleanup) {
        this.mutationTails.delete(agentId);
      }
    });
    this.mutationTails.set(agentId, cleanup);
    return next;
  }

  private async compactTimelineNow(agentId: string): Promise<TimelineCompactionResult> {
    const directory = this.agentDirectory(agentId);
    const bundlePath = path.join(directory, TIMELINE_BUNDLE_FILE);
    const tempPath = path.join(directory, TIMELINE_BUNDLE_TEMP_FILE);
    let read: Awaited<ReturnType<typeof readRawTimelineRows>>;
    try {
      read = await readRawTimelineRows(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "skipped", reason: "no-timeline" };
      }
      throw error;
    }
    await fs.rm(tempPath, { force: true });
    if (read.looseFileNames.length === 0) return { status: "skipped", reason: "no-loose-rows" };
    // Every row must load exactly as the store would load it before anything moves.
    for (const entry of read.rows) this.parseStoredRow(agentId, entry);

    const loosePaths = read.looseFileNames.map((name) => path.join(directory, name));
    const allocatedBytesBefore = await sumAllocatedBytes(
      read.hadBundle ? [...loosePaths, bundlePath] : loosePaths,
    );
    try {
      await this.writeBundleTemp(tempPath, read.rows);
      await this.verifyBundleTemp(agentId, directory, read.rows);
      await fs.rename(tempPath, bundlePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await syncDirectory(directory);
    ensurePrivateFile(bundlePath);

    for (let start = 0; start < loosePaths.length; start += COMPACTION_UNLINK_BATCH) {
      await Promise.all(
        loosePaths.slice(start, start + COMPACTION_UNLINK_BATCH).map(async (filePath) => {
          try {
            await fs.unlink(filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }),
      );
      await yieldToEventLoop();
    }
    return {
      status: "compacted",
      rows: read.rows.length,
      looseFilesRemoved: loosePaths.length,
      allocatedBytesBefore,
      allocatedBytesAfter: allocatedBytes(await fs.stat(bundlePath)),
    };
  }

  private async expandTimelineNow(agentId: string): Promise<TimelineExpansionResult> {
    const directory = this.agentDirectory(agentId);
    const bundlePath = path.join(directory, TIMELINE_BUNDLE_FILE);
    let read: Awaited<ReturnType<typeof readRawTimelineRows>>;
    try {
      read = await readRawTimelineRows(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "skipped", reason: "no-timeline" };
      }
      throw error;
    }
    await fs.rm(path.join(directory, TIMELINE_BUNDLE_TEMP_FILE), { force: true });
    if (!read.hadBundle) return { status: "skipped", reason: "no-bundle" };
    for (const entry of read.rows) this.parseStoredRow(agentId, entry);

    const missing = read.rows.filter((entry) => entry.source === "bundle");
    for (let start = 0; start < missing.length; start += COMPACTION_UNLINK_BATCH) {
      await Promise.all(
        missing
          .slice(start, start + COMPACTION_UNLINK_BATCH)
          .map((entry) =>
            writeDurableFile(
              path.join(directory, looseRowFileName(entry.seq)),
              JSON.stringify(entry.raw, null, 2),
            ),
          ),
      );
      await yieldToEventLoop();
    }
    await syncDirectory(directory);
    await this.verifyLooseRows(agentId, directory, read.rows);

    await fs.unlink(bundlePath);
    await syncDirectory(directory);
    return { status: "expanded", rows: read.rows.length, looseFilesWritten: missing.length };
  }

  /** Reads the loose files alone, as a loader without bundle support would. */
  private async verifyLooseRows(
    agentId: string,
    directory: string,
    rows: readonly RawTimelineRow[],
  ): Promise<void> {
    const { looseSeqs } = await listTimelineDirectory(directory);
    const expected = rows.map((entry) => entry.seq);
    if (!isDeepStrictEqual(looseSeqs, expected)) {
      throw new TimelineExpansionVerifyError(
        agentId,
        `${looseSeqs.length} loose files for ${expected.length} rows`,
      );
    }
    for (const entry of rows) {
      const raw: unknown = JSON.parse(await readLooseRowText(directory, entry.seq));
      if (!isDeepStrictEqual(raw, entry.raw)) {
        throw new TimelineExpansionVerifyError(agentId, `row ${entry.seq} differs`);
      }
    }
  }

  private async writeBundleTemp(tempPath: string, rows: readonly RawTimelineRow[]): Promise<void> {
    const handle = await fs.open(tempPath, "w", 0o600);
    try {
      let chunk: string[] = [];
      let chunkChars = 0;
      for (const row of rows) {
        const line = `${JSON.stringify(row.raw)}\n`;
        chunk.push(line);
        chunkChars += line.length;
        if (chunkChars >= COMPACTION_WRITE_CHUNK_CHARS) {
          await handle.appendFile(chunk.join(""), "utf8");
          chunk = [];
          chunkChars = 0;
        }
      }
      if (chunk.length > 0) await handle.appendFile(chunk.join(""), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Reads the temp bundle back from disk: same seqs, same order, byte-identical rows. */
  private async verifyBundleTemp(
    agentId: string,
    directory: string,
    rows: readonly RawTimelineRow[],
  ): Promise<void> {
    let index = 0;
    for await (const line of readBundleLines(directory, TIMELINE_BUNDLE_TEMP_FILE)) {
      const expected = rows[index];
      if (!expected || expected.seq !== line.seq) {
        throw new TimelineCompactionVerifyError(agentId, `unexpected seq ${line.seq}`);
      }
      if (line.text !== JSON.stringify(expected.raw)) {
        throw new TimelineCompactionVerifyError(agentId, `row ${line.seq} differs`);
      }
      JSON.parse(line.text);
      index += 1;
    }
    if (index !== rows.length) {
      throw new TimelineCompactionVerifyError(agentId, `${index} of ${rows.length} rows read back`);
    }
  }

  private parseStoredRow(agentId: string, entry: RawTimelineRow): AgentTimelineRow {
    const row = PersistedTimelineRowSchema.parse(entry.raw);
    if (row.seq !== entry.seq) {
      throw new Error(
        entry.source === "loose"
          ? `Timeline row filename does not match seq for '${agentId}'`
          : `Timeline bundle line seq does not match row seq for '${agentId}'`,
      );
    }
    return row;
  }

  private async load(agentId: string): Promise<CachedTimelineState> {
    assertSafeAgentId(agentId);
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const directory = this.agentDirectory(agentId);
    ensurePrivateDirectory(directory);
    // Bundle plus loose overlay, one row per seq by construction.
    const read = await readRawTimelineRows(directory);
    const rows = read.rows.map((entry) => this.parseStoredRow(agentId, entry));

    const persisted = await this.readState(agentId);
    const minimumNextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    const state: CachedTimelineState = {
      epoch: persisted?.epoch ?? randomUUID(),
      nextSeq: Math.max(persisted?.nextSeq ?? 1, minimumNextSeq),
      rows,
    };
    this.cache.set(agentId, state);
    if (!persisted || persisted.nextSeq !== state.nextSeq) {
      await this.writeState(agentId, state);
    }
    return state;
  }

  private async readState(
    agentId: string,
  ): Promise<z.infer<typeof PersistedTimelineStateSchema> | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath(agentId), "utf8"));
      return PersistedTimelineStateSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(agentId: string, state: CachedTimelineState): Promise<void> {
    const statePath = this.statePath(agentId);
    await writeJsonFileAtomic(statePath, {
      version: STORE_VERSION,
      epoch: state.epoch,
      nextSeq: state.nextSeq,
    });
    ensurePrivateFile(statePath);
  }

  private async writeRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    const rowPath = path.join(this.agentDirectory(agentId), looseRowFileName(row.seq));
    await writeJsonFileAtomic(rowPath, row);
    ensurePrivateFile(rowPath);
  }

  private agentDirectory(agentId: string): string {
    return path.join(this.baseDir, agentId);
  }

  private statePath(agentId: string): string {
    return path.join(this.agentDirectory(agentId), "state.json");
  }
}
