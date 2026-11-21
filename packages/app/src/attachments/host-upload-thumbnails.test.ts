import { describe, expect, it } from "vitest";
import { HostUploadThumbnailCache, type ThumbnailCacheStorage } from "./host-upload-thumbnails";

// Daseo delta 139: thumbnails of images attached on another device are fetched once per upload.
function memoryStorage(): ThumbnailCacheStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

const thumbnail = { data: "AAAA", mimeType: "image/jpeg", width: 4, height: 3 };

describe("HostUploadThumbnailCache", () => {
  it("fetches a thumbnail once, then answers from memory and, after a restart, from storage", async () => {
    const storage = memoryStorage();
    const fetched: string[] = [];
    const cache = new HostUploadThumbnailCache({ storage });
    cache.register("srv", async (uploadId) => {
      fetched.push(uploadId);
      return thumbnail;
    });

    const [first, concurrent] = await Promise.all([
      cache.resolve({ serverId: "srv", uploadId: "upload_a" }),
      cache.resolve({ serverId: "srv", uploadId: "upload_a" }),
    ]);
    await cache.resolve({ serverId: "srv", uploadId: "upload_a" });
    expect(first).toBe("data:image/jpeg;base64,AAAA");
    expect(concurrent).toBe(first);
    expect(fetched).toEqual(["upload_a"]);
    await cache.flush();

    const restarted = new HostUploadThumbnailCache({ storage });
    restarted.register("srv", async (uploadId) => {
      fetched.push(uploadId);
      return thumbnail;
    });
    await expect(restarted.resolve({ serverId: "srv", uploadId: "upload_a" })).resolves.toBe(first);
    expect(fetched).toEqual(["upload_a"]);
  });

  it("keeps only the most recent entries", async () => {
    const storage = memoryStorage();
    const fetched: string[] = [];
    const cache = new HostUploadThumbnailCache({ storage, maxEntries: 2 });
    cache.register("srv", async (uploadId) => {
      fetched.push(uploadId);
      return thumbnail;
    });
    for (const uploadId of ["a", "b", "a", "c", "a", "b"]) {
      await cache.resolve({ serverId: "srv", uploadId });
    }
    // b was evicted by c (a was used more recently), so it is fetched again.
    expect(fetched).toEqual(["a", "b", "c", "b"]);
  });

  it("fails without caching when the host is not attached or has no thumbnail", async () => {
    const cache = new HostUploadThumbnailCache({ storage: memoryStorage() });
    await expect(cache.resolve({ serverId: "srv", uploadId: "x" })).rejects.toThrow(
      "not connected",
    );
    let answer: typeof thumbnail | null = null;
    const unregister = cache.register("srv", async () => answer);
    await expect(cache.resolve({ serverId: "srv", uploadId: "x" })).rejects.toThrow(
      "without a preview",
    );
    answer = thumbnail;
    await expect(cache.resolve({ serverId: "srv", uploadId: "x" })).resolves.toBe(
      "data:image/jpeg;base64,AAAA",
    );
    unregister();
  });
});
