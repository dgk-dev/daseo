import { afterEach, describe, expect, it } from "vitest";
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

describe("attachment service", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
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
