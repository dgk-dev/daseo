import AsyncStorage from "@react-native-async-storage/async-storage";
import type { HostUploadThumbnail } from "@/attachments/types";

/**
 * Daseo delta 139: thumbnails of images attached on another device. A synced draft names the
 * upload only; the thumbnail bytes are fetched from the host once per upload id and kept in memory
 * and in a small persisted cache (the most recent `maxEntries`), so neither a draft change nor a
 * restart fetches them again.
 */
export interface ThumbnailCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type HostThumbnailFetcher = (uploadId: string) => Promise<HostUploadThumbnail | null>;

const STORAGE_KEY = "paseo-host-upload-thumbnails";
const DEFAULT_MAX_ENTRIES = 40;

interface PersistedEntry {
  key: string;
  dataUrl: string;
}

function cacheKey(serverId: string, uploadId: string): string {
  return `${serverId}:${uploadId}`;
}

function isPersistedEntry(value: unknown): value is PersistedEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PersistedEntry).key === "string" &&
    typeof (value as PersistedEntry).dataUrl === "string"
  );
}

export class HostUploadThumbnailCache {
  private readonly storage: ThumbnailCacheStorage;
  private readonly maxEntries: number;
  private readonly fetchers = new Map<string, HostThumbnailFetcher>();
  // Insertion order is recency: the oldest entry is first.
  private readonly entries = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(options: { storage: ThumbnailCacheStorage; maxEntries?: number }) {
    this.storage = options.storage;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Lets thumbnails of `serverId`'s uploads be fetched while that host is attached. */
  register(serverId: string, fetcher: HostThumbnailFetcher): () => void {
    this.fetchers.set(serverId, fetcher);
    return () => {
      if (this.fetchers.get(serverId) === fetcher) this.fetchers.delete(serverId);
    };
  }

  /** A data URL for the thumbnail; throws when the host has none or cannot be reached. */
  async resolve(input: { serverId: string; uploadId: string }): Promise<string> {
    const key = cacheKey(input.serverId, input.uploadId);
    await this.load();
    const cached = this.entries.get(key);
    if (cached) {
      this.touch(key, cached);
      return cached;
    }
    const pending = this.inFlight.get(key);
    if (pending) return await pending;
    const fetching = this.fetch(input, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, fetching);
    return await fetching;
  }

  private async fetch(input: { serverId: string; uploadId: string }, key: string): Promise<string> {
    const fetcher = this.fetchers.get(input.serverId);
    if (!fetcher) throw new Error("The host with this image is not connected.");
    const thumbnail = await fetcher(input.uploadId);
    if (!thumbnail) throw new Error("This image was attached on another device without a preview.");
    const dataUrl = `data:${thumbnail.mimeType};base64,${thumbnail.data}`;
    this.touch(key, dataUrl);
    this.persist();
    return dataUrl;
  }

  private touch(key: string, dataUrl: string): void {
    this.entries.delete(key);
    this.entries.set(key, dataUrl);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private load(): Promise<void> {
    this.loaded ??= this.storage.getItem(STORAGE_KEY).then(
      (raw) => {
        if (!raw) return undefined;
        try {
          const parsed = JSON.parse(raw) as { entries?: unknown };
          if (!Array.isArray(parsed.entries)) return undefined;
          for (const entry of parsed.entries) {
            if (isPersistedEntry(entry)) this.touch(entry.key, entry.dataUrl);
          }
        } catch {
          // An unreadable cache is refetched on demand.
        }
        return undefined;
      },
      () => undefined,
    );
    return this.loaded;
  }

  private persist(): void {
    const snapshot = JSON.stringify({
      version: 1,
      entries: Array.from(this.entries, ([key, dataUrl]) => ({ key, dataUrl })),
    });
    this.saving = this.saving
      .then(() => this.storage.setItem(STORAGE_KEY, snapshot))
      .catch(() => undefined);
  }

  /** Resolves when the last cache write finished (tests). */
  async flush(): Promise<void> {
    await this.saving;
  }
}

export const hostUploadThumbnails = new HostUploadThumbnailCache({ storage: AsyncStorage });
