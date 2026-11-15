import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { createAssistantImageAcquisitionCache } from "./acquisition-cache";
import {
  createAssistantImageFileAcquisition,
  type AssistantImageFileAcquisitionPort,
  type AssistantImageSnapshotCopyPersister,
} from "./file-acquisition";
import {
  createAssistantImageSnapshotCache,
  type AssistantImageSnapshotBytesStore,
  type AssistantImageSnapshotIndexStorage,
} from "./snapshot-cache";

class MemoryFileAcquisitionPort implements AssistantImageFileAcquisitionPort {
  readonly reads: Array<{ cwd: string; path: string }> = [];

  async readFile(cwd: string, path: string) {
    this.reads.push({ cwd, path });
    return {
      kind: "image" as const,
      path,
      mime: "image/png",
      size: 4,
      modifiedAt: "1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
  }

  async persist(input: { id: string; mimeType: string; fileName: string | null }) {
    return {
      id: input.id,
      mimeType: input.mimeType,
      storageType: "web-indexeddb" as const,
      storageKey: input.id,
      fileName: input.fileName,
      byteSize: 4,
      createdAt: 1,
    } satisfies AttachmentMetadata;
  }
}

describe("assistant image file acquisition", () => {
  it("recreates the same acquisition with a live port after reconnect", async () => {
    const common = {
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "reconnect.png" },
      serverId: "server",
      occurrenceKey: "agent:message:reconnect-image",
      unavailableMessage: "Image unavailable",
    };
    const disconnected = createAssistantImageFileAcquisition({ ...common, port: null });
    const connectedPort = new MemoryFileAcquisitionPort();
    const connected = createAssistantImageFileAcquisition({ ...common, port: connectedPort });

    expect(disconnected?.key).toBe(connected?.key);
    await expect(disconnected?.locate()).rejects.toThrow("Image unavailable");
    await expect(connected?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
    expect(connectedPort.reads).toEqual([{ cwd: "/workspace", path: "reconnect.png" }]);
  });

  it("a retry after failure starts a fresh acquisition instead of the failed one", async () => {
    const cache = createAssistantImageAcquisitionCache<AttachmentMetadata>({ capacity: 10 });
    const port = new MemoryFileAcquisitionPort();
    let reachable = false;
    const flakyPort: AssistantImageFileAcquisitionPort = {
      readFile: async (cwd, path) => {
        if (!reachable) {
          throw new Error("host unreachable");
        }
        return await port.readFile(cwd, path);
      },
      persist: (input) => port.persist(input),
    };
    const common = {
      port: flakyPort,
      resolution: { kind: "file_rpc" as const, cwd: "/workspace", path: "retry.png" },
      serverId: "server",
      occurrenceKey: "agent:message:retry-image",
      unavailableMessage: "Image unavailable",
    };
    const failed = createAssistantImageFileAcquisition(common);
    if (!failed) throw new Error("expected an acquisition");
    await expect(cache.acquire(failed.key, failed.locate)).rejects.toThrow("host unreachable");

    reachable = true;
    const retried = createAssistantImageFileAcquisition({ ...common, generation: 1 });
    if (!retried) throw new Error("expected an acquisition");
    expect(retried.key).not.toBe(failed.key);
    await expect(cache.acquire(retried.key, retried.locate)).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("shows a snapshot this device already stored after a restart without asking the host", async () => {
    const stored = new Map<string, Uint8Array>();
    const bytes: AssistantImageSnapshotBytesStore = {
      read: async (name) =>
        stored.has(name) ? { kind: "file_uri", uri: `file:///c/${name}` } : null,
      write: async ({ name, bytes: value }) => {
        stored.set(name, value);
      },
      delete: async (name) => {
        stored.delete(name);
      },
    };
    let indexValue: string | null = null;
    const index: AssistantImageSnapshotIndexStorage = {
      load: async () => indexValue,
      save: async (value) => {
        indexValue = value;
      },
    };
    const copies: string[] = [];
    const persistSnapshotCopy: AssistantImageSnapshotCopyPersister = async (input) => {
      copies.push(input.copy.kind === "file_uri" ? input.copy.uri : "blob");
      return {
        id: input.id,
        mimeType: input.mimeType,
        storageType: "native-file",
        storageKey: `/attachments/${input.id}`,
        fileName: input.fileName,
        byteSize: 4,
        createdAt: 1,
      };
    };
    const hash = "a".repeat(64);
    const resolution = {
      kind: "file_rpc" as const,
      cwd: "/",
      path: `/Users/me/.paseo/assistant-images/blobs/${hash}.png`,
    };
    const online = new MemoryFileAcquisitionPort();
    const firstRun = createAssistantImageSnapshotCache({ bytes, index });
    const first = createAssistantImageFileAcquisition({
      port: online,
      resolution,
      serverId: "server",
      occurrenceKey: "agent:message-1:image",
      unavailableMessage: "Image unavailable",
      loadSnapshotCache: async () => firstRun,
      persistSnapshotCopy,
    });
    await expect(first?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
    expect(online.reads).toHaveLength(1);

    // App restart, host offline: a new cache instance over the same storage, no port.
    const restarted = createAssistantImageSnapshotCache({ bytes, index });
    const offline = createAssistantImageFileAcquisition({
      port: null,
      resolution,
      serverId: "server",
      occurrenceKey: "agent:message-2:image",
      unavailableMessage: "Image unavailable",
      loadSnapshotCache: async () => restarted,
      persistSnapshotCopy,
    });
    expect(offline?.key).toBe(first?.key);
    await expect(offline?.locate()).resolves.toMatchObject({ mimeType: "image/png" });
    expect(copies).toEqual([`file:///c/server_${hash}.png`]);
  });
});
