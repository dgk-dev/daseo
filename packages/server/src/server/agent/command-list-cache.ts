import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { expandTilde } from "../../utils/path.js";
import { preserveUnreadableFile, writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentProvider, AgentSlashCommand } from "./agent-sdk-types.js";

/**
 * Daseo delta 138: the "/" command list per provider and working directory, kept by the daemon so
 * an idle-unloaded agent or a draft composer answers without starting a provider process. Pi's
 * list comes from extensions, prompt templates, and skills, which depend on cwd and global config,
 * not on model, mode, or thinking, so those are not part of the key.
 *
 * Stored at `$PASEO_HOME/command-lists.json`, most recently used first, bounded to
 * `maxEntries` keys. A cached answer is returned at once; a background refresh runs single-flight
 * per key, at most once per `refreshIntervalMs` per key, and a failed refresh keeps the old entry.
 */
export interface CommandListKey {
  provider: AgentProvider;
  cwd: string;
}

export type ComputeCommandList = () => Promise<AgentSlashCommand[]>;

export interface CommandListCacheOptions {
  /** Null keeps the cache in memory only. */
  filePath: string | null;
  logger: pino.Logger;
  now?: () => number;
  maxEntries?: number;
  refreshIntervalMs?: number;
}

export const COMMAND_LIST_CACHE_MAX_ENTRIES = 50;
export const COMMAND_LIST_REFRESH_INTERVAL_MS = 5 * 60_000;

const CachedCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  kind: z.enum(["command", "skill"]).optional(),
});

const CommandListFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      provider: z.string(),
      cwd: z.string(),
      updatedAt: z.string(),
      commands: z.array(CachedCommandSchema),
    }),
  ),
});

interface CommandListEntry {
  key: CommandListKey;
  commands: AgentSlashCommand[];
  /** Epoch ms of the last successful answer (live or computed). */
  updatedAt: number;
}

/** The cache key for a provider and a cwd as clients send it (`~` expanded, resolved). */
export function normalizeCommandListKey(key: CommandListKey): CommandListKey {
  return { provider: key.provider, cwd: path.resolve(expandTilde(key.cwd)) };
}

function keyId(key: CommandListKey): string {
  return `${key.provider}\u0000${key.cwd}`;
}

function sameCommands(a: AgentSlashCommand[], b: AgentSlashCommand[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class CommandListCache {
  private readonly filePath: string | null;
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly refreshIntervalMs: number;
  /** Insertion order is recency: the last entry is the most recently used. */
  private readonly entries = new Map<string, CommandListEntry>();
  private readonly inflight = new Map<string, Promise<AgentSlashCommand[]>>();
  private readonly lastRefreshAttemptAt = new Map<string, number>();
  private loaded: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private persistQueued = false;

  constructor(options: CommandListCacheOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger.child({ module: "command-list-cache" });
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? COMMAND_LIST_CACHE_MAX_ENTRIES;
    this.refreshIntervalMs = options.refreshIntervalMs ?? COMMAND_LIST_REFRESH_INTERVAL_MS;
  }

  /**
   * The cached list for `key`, refreshed in the background when due; on a miss `compute` runs
   * once for all concurrent callers of the same key and its result is stored.
   */
  async resolve(key: CommandListKey, compute: ComputeCommandList): Promise<AgentSlashCommand[]> {
    await this.load();
    const normalized = normalizeCommandListKey(key);
    const id = keyId(normalized);
    const entry = this.entries.get(id);
    if (!entry) {
      return this.computeShared(id, normalized, compute);
    }
    this.touch(id, entry);
    this.refreshIfDue(id, normalized, entry, compute);
    return entry.commands;
  }

  /** Records a list a live agent answered; it counts as a fresh answer for its key. */
  async store(key: CommandListKey, commands: AgentSlashCommand[]): Promise<void> {
    await this.load();
    const normalized = normalizeCommandListKey(key);
    this.put(keyId(normalized), normalized, commands);
  }

  /** Resolves once every write scheduled so far has finished. */
  async flush(): Promise<void> {
    await this.writes;
  }

  private computeShared(
    id: string,
    key: CommandListKey,
    compute: ComputeCommandList,
  ): Promise<AgentSlashCommand[]> {
    const existing = this.inflight.get(id);
    if (existing) {
      return existing;
    }
    this.lastRefreshAttemptAt.set(id, this.now());
    const run = (async () => {
      try {
        const commands = await compute();
        this.put(id, key, commands);
        return commands;
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, run);
    return run;
  }

  private refreshIfDue(
    id: string,
    key: CommandListKey,
    entry: CommandListEntry,
    compute: ComputeCommandList,
  ): void {
    if (this.inflight.has(id)) {
      return;
    }
    const lastAttempt = Math.max(entry.updatedAt, this.lastRefreshAttemptAt.get(id) ?? 0);
    if (this.now() - lastAttempt < this.refreshIntervalMs) {
      return;
    }
    this.computeShared(id, key, compute).catch((error: unknown) => {
      this.logger.debug(
        { err: error, provider: key.provider, cwd: key.cwd },
        "Command list refresh failed; keeping the cached list",
      );
    });
  }

  private touch(id: string, entry: CommandListEntry): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private put(id: string, key: CommandListKey, commands: AgentSlashCommand[]): void {
    const previous = this.entries.get(id);
    const changed = !previous || !sameCommands(previous.commands, commands);
    this.entries.delete(id);
    this.entries.set(id, { key, commands, updatedAt: this.now() });
    let evicted = false;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.lastRefreshAttemptAt.delete(oldest);
      evicted = true;
    }
    if (changed || evicted) {
      this.schedulePersist();
    }
  }

  private schedulePersist(): void {
    const filePath = this.filePath;
    if (!filePath || this.persistQueued) {
      return;
    }
    this.persistQueued = true;
    this.writes = this.writes.then(() => this.persist(filePath));
  }

  private async persist(filePath: string): Promise<void> {
    // Cleared before the snapshot so a change during this write queues the next one.
    this.persistQueued = false;
    try {
      await writeJsonFileAtomic(filePath, this.snapshot());
    } catch (error) {
      this.logger.warn({ err: error, filePath }, "Failed to write command list cache");
    }
  }

  private snapshot(): z.infer<typeof CommandListFileSchema> {
    const entries = Array.from(this.entries.values())
      .toReversed()
      .map((entry) => ({
        provider: entry.key.provider,
        cwd: entry.key.cwd,
        updatedAt: new Date(entry.updatedAt).toISOString(),
        commands: entry.commands,
      }));
    return { version: 1, entries };
  }

  private load(): Promise<void> {
    this.loaded ??= this.readFromDisk();
    return this.loaded;
  }

  private async readFromDisk(): Promise<void> {
    const filePath = this.filePath;
    if (!filePath) {
      return;
    }
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, filePath }, "Command list cache unreadable");
      }
      return;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = CommandListFileSchema.safeParse(json);
    if (!parsed.success) {
      const backupPath = await preserveUnreadableFile(filePath);
      this.logger.warn(
        { filePath, backupPath },
        "Command list cache file invalid; starting with an empty cache",
      );
      return;
    }
    // The file lists the most recently used entry first; the map keeps it last.
    const kept = parsed.data.entries.slice(0, this.maxEntries).toReversed();
    for (const stored of kept) {
      const updatedAt = Date.parse(stored.updatedAt);
      const key = normalizeCommandListKey({
        provider: stored.provider,
        cwd: stored.cwd,
      });
      this.entries.set(keyId(key), {
        key,
        commands: stored.commands,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
  }
}
