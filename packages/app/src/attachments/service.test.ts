import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata, AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "./store";
import {
  encodeAttachmentsForSend,
  garbageCollectAttachments,
  persistAttachmentFromBytes,
} from "./service";

function createAttachment(input: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: input.id ?? "att_1",
    mimeType: input.mimeType ?? "image/png",
    storageType: input.storageType ?? "web-indexeddb",
    storageKey: input.storageKey ?? "att_1",
    fileName: input.fileName,
    byteSize: input.byteSize,
    createdAt: input.createdAt ?? 1700000000000,
  };
}

function createRecordingStore(): AttachmentStore & {
  savedSources: SaveAttachmentInput[];
  releasedUrls: string[];
} {
  const savedSources: SaveAttachmentInput[] = [];
  const releasedUrls: string[] = [];

  return {
    storageType: "web-indexeddb",
    savedSources,
    releasedUrls,
    async save(input) {
      savedSources.push(input);
      return createAttachment({
        id: input.id,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteSize: 4,
      });
    },
    async encodeBase64({ attachment }) {
      return `${attachment.id}:base64`;
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async releasePreviewUrl({ url }) {
      releasedUrls.push(url);
    },
    async delete() {},
    async garbageCollect() {},
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A store that keeps real bytes, for paths that decode what they stored. */
function createBytesStore(): AttachmentStore & { deletedIds: string[] } {
  const bytesById = new Map<string, Uint8Array>();
  const deletedIds: string[] = [];
  let next = 0;
  return {
    storageType: "web-indexeddb",
    deletedIds,
    async save(input) {
      const id = input.id ?? `saved_${(next += 1)}`;
      let bytes: Uint8Array;
      if (input.source.kind === "bytes") bytes = input.source.bytes;
      else if (input.source.kind === "blob")
        bytes = new Uint8Array(await input.source.blob.arrayBuffer());
      else throw new Error("unsupported source in test");
      bytesById.set(id, bytes);
      return createAttachment({
        id,
        storageKey: id,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteSize: bytes.byteLength,
      });
    },
    async encodeBase64({ attachment }) {
      return bytesToBase64(bytesById.get(attachment.id) ?? new Uint8Array());
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async delete({ attachment }) {
      deletedIds.push(attachment.id);
      bytesById.delete(attachment.id);
    },
    async garbageCollect() {},
  };
}

describe("attachment service", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
    vi.unstubAllGlobals();
  });

  it("persists raw bytes without requiring a base64 wrapper", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await persistAttachmentFromBytes({
      id: "att_bytes",
      bytes,
      mimeType: "image/png",
      fileName: "image.png",
    });

    expect(attachment).toEqual({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_1",
      fileName: "image.png",
      byteSize: 4,
      createdAt: 1700000000000,
    });
    expect(store.savedSources).toEqual([
      {
        id: "att_bytes",
        mimeType: "image/png",
        fileName: "image.png",
        source: { kind: "bytes", bytes },
      },
    ]);
  });

  it("keeps provider send output byte-compatible", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const attachment = createAttachment({ id: "att_send", mimeType: "image/jpeg" });
    const legacyJpgAttachment = createAttachment({ id: "att_jpg", mimeType: "image/jpg" });

    await expect(encodeAttachmentsForSend([attachment, legacyJpgAttachment])).resolves.toEqual([
      { data: "att_send:base64", mimeType: "image/jpeg" },
      { data: "att_jpg:base64", mimeType: "image/jpeg" },
    ]);
  });

  it("fails the whole send instead of silently omitting an unreadable image", async () => {
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async encodeBase64() {
        throw new Error("missing attachment bytes");
      },
    };
    __setAttachmentStoreForTests(store);

    await expect(
      encodeAttachmentsForSend([
        createAttachment({ id: "att_missing", fileName: "clipboard.png" }),
      ]),
    ).rejects.toThrow("Failed to read image attachment 'clipboard.png'. The message was not sent.");
  });

  it("rejects an empty encoded image instead of sending an invisible attachment", async () => {
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async encodeBase64() {
        return "";
      },
    };
    __setAttachmentStoreForTests(store);

    await expect(encodeAttachmentsForSend([createAttachment({ id: "att_empty" })])).rejects.toThrow(
      "Failed to read image attachment 'att_empty'. The message was not sent.",
    );
  });

  it("rejects provider-incompatible formats before silently dropping them", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);

    await expect(
      encodeAttachmentsForSend([
        createAttachment({
          id: "att_heic",
          mimeType: "image/heic",
          fileName: "camera.heic",
        }),
      ]),
    ).rejects.toThrow("Unsupported image format 'image/heic'. Use PNG, JPEG, GIF, or WebP.");
  });

  it("refuses at attach time an image format this runtime cannot convert, instead of failing at send", async () => {
    const store = createBytesStore();
    __setAttachmentStoreForTests(store);
    vi.stubGlobal("createImageBitmap", undefined);

    await expect(
      persistAttachmentFromBytes({
        id: "att_heic",
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
        mimeType: "image/heic",
        fileName: "camera.heic",
      }),
    ).rejects.toThrow("camera.heic is a HEIC image, which this device can't convert");
    expect(store.deletedIds).toEqual(["att_heic"]);
  });

  it("converts a decodable BMP to JPEG when it is attached", async () => {
    const store = createBytesStore();
    __setAttachmentStoreForTests(store);
    const bitmap = { width: 2, height: 1, close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
        }
        async convertToBlob() {
          return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
        }
      },
    );
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setUint32(14, 40, true);
    new DataView(bmp.buffer).setInt32(18, 2, true);
    new DataView(bmp.buffer).setInt32(22, 1, true);

    const attachment = await persistAttachmentFromBytes({
      id: "att_bmp",
      bytes: bmp,
      mimeType: "image/bmp",
      fileName: "diagram.bmp",
    });

    expect(attachment).toMatchObject({ mimeType: "image/jpeg", fileName: "diagram.jpg" });
    expect(store.deletedIds).toEqual(["att_bmp"]);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("does not collect an attachment persisted while garbage collection is starting", async () => {
    let releaseSave: () => void = () => undefined;
    let reportSaveStarted: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const garbageCollections: string[][] = [];
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async save(input) {
        reportSaveStarted();
        await saveGate;
        return createAttachment({ id: input.id });
      },
      async garbageCollect({ referencedIds }) {
        garbageCollections.push([...referencedIds]);
      },
    };
    __setAttachmentStoreForTests(store);

    const persist = persistAttachmentFromBytes({
      id: "assistant-preview",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    await saveStarted;
    const collect = garbageCollectAttachments({ referencedIds: new Set() });

    try {
      await Promise.resolve();
      expect(garbageCollections).toEqual([]);
    } finally {
      releaseSave();
      await Promise.all([persist, collect]);
    }

    expect(garbageCollections).toEqual([["assistant-preview"]]);
  });
});
