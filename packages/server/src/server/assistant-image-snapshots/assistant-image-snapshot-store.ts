import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

/**
 * Daseo: durable, content-addressed copies of images shown in assistant messages.
 *
 * Layout under the root (`$PASEO_HOME/assistant-images`):
 * - `blobs/<sha256>.<ext>`: the bytes, stored once however many messages show them.
 * - `agents/<agentId>.json`: which source path each snapshot was taken from and when. It is
 *   the reference count for deletion and the lookup when history is rebuilt from a provider.
 *
 * Everything is synchronous: snapshots are taken while a timeline item is recorded, and that
 * path is synchronous so stream order holds. Synchronous calls also cannot interleave, so a
 * deletion never races a write of the same blob.
 */
export const ASSISTANT_IMAGE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

const SNAPSHOT_FILE_NAME = /^([0-9a-f]{64})\.([a-z0-9]+)$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const snapshotEntrySchema = z.object({
  source: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  ext: z.string().regex(/^[a-z0-9]+$/),
  emittedAt: z.string(),
});

const agentSnapshotsSchema = z.object({
  version: z.literal(1),
  entries: z.array(snapshotEntrySchema),
});

export type AssistantImageSnapshotEntry = z.infer<typeof snapshotEntrySchema>;

export interface AssistantImageSnapshotStoreOptions {
  rootDir: string;
  maxImageBytes?: number;
}

export class AssistantImageSnapshotStore {
  readonly rootDir: string;
  readonly blobDir: string;
  private readonly agentDir: string;
  private readonly maxImageBytes: number;
  private readonly agentEntries = new Map<string, AssistantImageSnapshotEntry[]>();

  constructor(options: AssistantImageSnapshotStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.blobDir = path.join(this.rootDir, "blobs");
    this.agentDir = path.join(this.rootDir, "agents");
    this.maxImageBytes = options.maxImageBytes ?? ASSISTANT_IMAGE_SNAPSHOT_MAX_BYTES;
  }

  blobPath(entry: Pick<AssistantImageSnapshotEntry, "hash" | "ext">): string {
    return path.join(this.blobDir, `${entry.hash}.${entry.ext}`);
  }

  /** The hash and extension of a path inside the blob directory, or null for any other path. */
  parseSnapshotPath(filePath: string): { hash: string; ext: string } | null {
    if (path.dirname(path.resolve(filePath)) !== this.blobDir) {
      return null;
    }
    const match = path.basename(filePath).match(SNAPSHOT_FILE_NAME);
    return match ? { hash: match[1], ext: match[2] } : null;
  }

  /**
   * Copies `resolvedPath` into the blob store and records that `agentId` showed it as
   * `source`. Returns the entry, or null when the file is missing, not a regular file, or
   * larger than the per-image cap (the caller then keeps the live path).
   */
  snapshot(input: {
    agentId: string;
    source: string;
    resolvedPath: string;
    emittedAt: string;
  }): AssistantImageSnapshotEntry | null {
    const ext = path.extname(input.resolvedPath).slice(1).toLowerCase();
    if (!/^[a-z0-9]+$/.test(ext)) {
      return null;
    }
    let bytes: Buffer;
    try {
      const stats = fs.statSync(input.resolvedPath);
      if (!stats.isFile() || stats.size > this.maxImageBytes) {
        return null;
      }
      bytes = fs.readFileSync(input.resolvedPath);
    } catch {
      return null;
    }
    if (bytes.byteLength > this.maxImageBytes) {
      return null;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const entry: AssistantImageSnapshotEntry = {
      source: input.source,
      hash,
      ext,
      emittedAt: input.emittedAt,
    };
    this.writeBlob(entry, bytes);
    this.addEntry(input.agentId, entry);
    return entry;
  }

  /** Records that `agentId` shows an existing snapshot, so deleting another agent keeps it. */
  reference(input: { agentId: string; hash: string; ext: string; emittedAt: string }): boolean {
    const entry: AssistantImageSnapshotEntry = {
      source: this.blobPath(input),
      hash: input.hash,
      ext: input.ext,
      emittedAt: input.emittedAt,
    };
    if (!fs.existsSync(this.blobPath(entry))) {
      return false;
    }
    if (
      this.readEntries(input.agentId).some(
        (existing) => existing.hash === entry.hash && existing.ext === entry.ext,
      )
    ) {
      return true;
    }
    this.addEntry(input.agentId, entry);
    return true;
  }

  /** Snapshots `agentId` took from `source`, in emission order, whose blob still exists. */
  entriesFor(agentId: string, source: string): AssistantImageSnapshotEntry[] {
    return this.readEntries(agentId).filter(
      (entry) => entry.source === source && fs.existsSync(this.blobPath(entry)),
    );
  }

  /** Removes the agent's references, then every blob no other agent references. */
  deleteAgent(agentId: string): void {
    const entries = this.readEntries(agentId);
    this.agentEntries.delete(agentId);
    fs.rmSync(this.agentFilePath(agentId), { force: true });
    if (entries.length === 0) {
      return;
    }
    const stillReferenced = this.collectReferencedBlobNames();
    for (const entry of entries) {
      const name = `${entry.hash}.${entry.ext}`;
      if (!stillReferenced.has(name)) {
        fs.rmSync(path.join(this.blobDir, name), { force: true });
      }
    }
  }

  /**
   * Deletes blobs no agent references: left by a daemon that stopped between writing a blob
   * and its reference. Run at daemon start, before any agent records a timeline item.
   */
  sweepUnreferencedBlobs(): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.blobDir);
    } catch {
      return 0;
    }
    const referenced = this.collectReferencedBlobNames();
    let removed = 0;
    for (const name of names) {
      if (referenced.has(name)) {
        continue;
      }
      fs.rmSync(path.join(this.blobDir, name), { force: true, recursive: true });
      removed += 1;
    }
    return removed;
  }

  private collectReferencedBlobNames(): Set<string> {
    const referenced = new Set<string>();
    let files: string[];
    try {
      files = fs.readdirSync(this.agentDir);
    } catch {
      return referenced;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const agentId = decodeURIComponent(file.slice(0, -".json".length));
      for (const entry of this.readEntries(agentId)) {
        referenced.add(`${entry.hash}.${entry.ext}`);
      }
    }
    return referenced;
  }

  private writeBlob(entry: AssistantImageSnapshotEntry, bytes: Buffer): void {
    const target = this.blobPath(entry);
    if (fs.existsSync(target)) {
      return;
    }
    fs.mkdirSync(this.blobDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporary, target);
  }

  private addEntry(agentId: string, entry: AssistantImageSnapshotEntry): void {
    const entries = [...this.readEntries(agentId), entry];
    fs.mkdirSync(this.agentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const target = this.agentFilePath(agentId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), {
      mode: PRIVATE_FILE_MODE,
    });
    fs.renameSync(temporary, target);
    this.agentEntries.set(agentId, entries);
  }

  private readEntries(agentId: string): AssistantImageSnapshotEntry[] {
    const cached = this.agentEntries.get(agentId);
    if (cached) {
      return cached;
    }
    let entries: AssistantImageSnapshotEntry[] = [];
    try {
      const raw = fs.readFileSync(this.agentFilePath(agentId), "utf8");
      const parsed = agentSnapshotsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        entries = parsed.data.entries;
      }
    } catch {
      entries = [];
    }
    this.agentEntries.set(agentId, entries);
    return entries;
  }

  private agentFilePath(agentId: string): string {
    return path.join(this.agentDir, `${encodeURIComponent(agentId)}.json`);
  }
}
