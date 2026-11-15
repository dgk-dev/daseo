/**
 * Daseo: a durable, size-bounded copy of assistant image snapshots this device has shown.
 *
 * The daemon stores an image shown in an assistant message as an immutable,
 * content-addressed snapshot (`…/assistant-images/blobs/<sha256>.<ext>`), so a copy keyed by
 * host and hash never goes stale. Keeping that copy outside the attachment store lets a
 * restarted app show it without a host round trip (offline too): the attachment store is
 * garbage-collected against drafts on every draft save and only retains in-memory consumers.
 */
export type AssistantImageSnapshotCopy =
  | { kind: "file_uri"; uri: string }
  | { kind: "blob"; blob: Blob };

/** Where the bytes live: a cache directory on native, IndexedDB on web and desktop. */
export interface AssistantImageSnapshotBytesStore {
  read(name: string): Promise<AssistantImageSnapshotCopy | null>;
  write(input: { name: string; bytes: Uint8Array; mimeType: string }): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Where the index lives (recency and sizes); one serialized value. */
export interface AssistantImageSnapshotIndexStorage {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

export interface AssistantImageSnapshotCache {
  get(key: string): Promise<{ copy: AssistantImageSnapshotCopy; mimeType: string } | null>;
  put(key: string, input: { bytes: Uint8Array; mimeType: string }): Promise<void>;
  forget(key: string): Promise<void>;
}

interface IndexEntry {
  key: string;
  name: string;
  mimeType: string;
  byteSize: number;
}

interface SerializedIndex {
  version: 1;
  /** Least recently used first. */
  entries: IndexEntry[];
}

/** Same count as the in-memory acquisition caches; the byte bound is new because this persists. */
export const ASSISTANT_IMAGE_SNAPSHOT_CACHE_MAX_ENTRIES = 500;
export const ASSISTANT_IMAGE_SNAPSHOT_CACHE_MAX_BYTES = 200 * 1024 * 1024;

export function createAssistantImageSnapshotCacheKey(input: {
  serverId?: string;
  hash: string;
  ext: string;
}): string {
  return `${input.serverId ?? "unknown-server"}:${input.hash}.${input.ext}`;
}

function fileNameForKey(key: string): string {
  return key.replace(/[^A-Za-z0-9.-]/g, "_");
}

function parseIndex(raw: string | null): IndexEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedIndex>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries.filter(
      (entry): entry is IndexEntry =>
        typeof entry?.key === "string" &&
        typeof entry.name === "string" &&
        typeof entry.mimeType === "string" &&
        typeof entry.byteSize === "number",
    );
  } catch {
    return [];
  }
}

export function createAssistantImageSnapshotCache(input: {
  bytes: AssistantImageSnapshotBytesStore;
  index: AssistantImageSnapshotIndexStorage;
  maxEntries?: number;
  maxBytes?: number;
}): AssistantImageSnapshotCache {
  const maxEntries = input.maxEntries ?? ASSISTANT_IMAGE_SNAPSHOT_CACHE_MAX_ENTRIES;
  const maxBytes = input.maxBytes ?? ASSISTANT_IMAGE_SNAPSHOT_CACHE_MAX_BYTES;
  const entries = new Map<string, IndexEntry>();
  let loaded: Promise<void> | null = null;
  // Index writes and deletions run one at a time so a slow save never overwrites a newer one.
  let tail: Promise<void> = Promise.resolve();

  function ensureLoaded(): Promise<void> {
    loaded ??= (async () => {
      const stored = parseIndex(await input.index.load().catch(() => null));
      for (const entry of stored) {
        entries.set(entry.key, entry);
      }
    })();
    return loaded;
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  }

  function persistIndex(): Promise<void> {
    const snapshot: SerializedIndex = { version: 1, entries: Array.from(entries.values()) };
    return enqueue(async () => {
      await input.index.save(JSON.stringify(snapshot));
    });
  }

  function totalBytes(): number {
    let total = 0;
    for (const entry of entries.values()) {
      total += entry.byteSize;
    }
    return total;
  }

  function touch(entry: IndexEntry): void {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
  }

  function evictOverflow(): IndexEntry[] {
    const evicted: IndexEntry[] = [];
    while (entries.size > maxEntries || (entries.size > 1 && totalBytes() > maxBytes)) {
      const oldest = entries.values().next().value;
      if (!oldest) {
        break;
      }
      entries.delete(oldest.key);
      evicted.push(oldest);
    }
    return evicted;
  }

  async function deleteBytes(removed: IndexEntry[]): Promise<void> {
    await Promise.all(
      removed.map((entry) => input.bytes.delete(entry.name).catch(() => undefined)),
    );
  }

  return {
    async get(key) {
      await ensureLoaded();
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      const copy = await input.bytes.read(entry.name).catch(() => null);
      if (!copy) {
        // The platform purged the cache directory; the index forgets the entry.
        entries.delete(key);
        await persistIndex();
        return null;
      }
      touch(entry);
      void persistIndex().catch(() => undefined);
      return { copy, mimeType: entry.mimeType };
    },
    async put(key, value) {
      await ensureLoaded();
      if (value.bytes.byteLength > maxBytes) {
        return;
      }
      const existing = entries.get(key);
      if (existing) {
        touch(existing);
        await persistIndex();
        return;
      }
      const entry: IndexEntry = {
        key,
        name: fileNameForKey(key),
        mimeType: value.mimeType,
        byteSize: value.bytes.byteLength,
      };
      await input.bytes.write({ name: entry.name, bytes: value.bytes, mimeType: value.mimeType });
      entries.set(key, entry);
      const evicted = evictOverflow();
      await persistIndex();
      await deleteBytes(evicted);
    },
    async forget(key) {
      await ensureLoaded();
      const entry = entries.get(key);
      if (!entry) {
        return;
      }
      entries.delete(key);
      await persistIndex();
      await deleteBytes([entry]);
    },
  };
}
