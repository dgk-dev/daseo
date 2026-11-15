import { describe, expect, it } from "vitest";
import {
  createAssistantImageSnapshotCache,
  type AssistantImageSnapshotBytesStore,
  type AssistantImageSnapshotIndexStorage,
} from "./snapshot-cache";

class MemoryBytes implements AssistantImageSnapshotBytesStore {
  readonly files = new Map<string, Uint8Array>();

  async read(name: string) {
    return this.files.has(name)
      ? { kind: "file_uri" as const, uri: `file:///cache/${name}` }
      : null;
  }

  async write(input: { name: string; bytes: Uint8Array }) {
    this.files.set(input.name, input.bytes);
  }

  async delete(name: string) {
    this.files.delete(name);
  }
}

class MemoryIndex implements AssistantImageSnapshotIndexStorage {
  value: string | null = null;

  async load() {
    return this.value;
  }

  async save(value: string) {
    this.value = value;
  }
}

describe("assistant image snapshot cache", () => {
  it("finds a stored snapshot after a restart", async () => {
    const bytes = new MemoryBytes();
    const index = new MemoryIndex();
    const first = createAssistantImageSnapshotCache({ bytes, index });
    await first.put("server:abc.png", { bytes: new Uint8Array([1, 2]), mimeType: "image/png" });

    const restarted = createAssistantImageSnapshotCache({ bytes, index });
    await expect(restarted.get("server:abc.png")).resolves.toEqual({
      copy: { kind: "file_uri", uri: "file:///cache/server_abc.png" },
      mimeType: "image/png",
    });
  });

  it("evicts the least recently used snapshot beyond the entry and byte limits", async () => {
    const bytes = new MemoryBytes();
    const cache = createAssistantImageSnapshotCache({
      bytes,
      index: new MemoryIndex(),
      maxEntries: 2,
      maxBytes: 5,
    });
    await cache.put("a", { bytes: new Uint8Array(2), mimeType: "image/png" });
    await cache.put("b", { bytes: new Uint8Array(2), mimeType: "image/png" });
    await cache.get("a");
    await cache.put("c", { bytes: new Uint8Array(2), mimeType: "image/png" });

    expect(Array.from(bytes.files.keys()).sort()).toEqual(["a", "c"]);
    await expect(cache.get("b")).resolves.toBeNull();

    await cache.put("d", { bytes: new Uint8Array(4), mimeType: "image/png" });
    expect(Array.from(bytes.files.keys())).toEqual(["d"]);
  });

  it("forgets an entry whose bytes the platform purged", async () => {
    const bytes = new MemoryBytes();
    const index = new MemoryIndex();
    const cache = createAssistantImageSnapshotCache({ bytes, index });
    await cache.put("a", { bytes: new Uint8Array(1), mimeType: "image/png" });
    bytes.files.clear();

    await expect(cache.get("a")).resolves.toBeNull();
    expect(JSON.parse(index.value ?? "{}").entries).toEqual([]);
  });
});
