import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clipboardDataMayContainImage,
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
  persistClipboardImageCandidates,
  readCanonicalDesktopClipboardImage,
  withImagePastePending,
} from "./image-attachments-from-files";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";

function createClipboardItem(params: { kind: string; type: string; file?: File | null }) {
  return {
    kind: params.kind,
    type: params.type,
    getAsFile: () => params.file ?? null,
  };
}

function createTestStore(): AttachmentStore {
  let sequence = 0;
  return {
    storageType: "web-indexeddb",
    async save(input) {
      sequence += 1;
      const id = input.id ?? `att-${sequence}`;
      const mimeType = input.mimeType ?? "image/jpeg";
      const fileName = input.fileName ?? null;
      let byteSize = 0;
      if (input.source.kind === "blob") {
        byteSize = input.source.blob.size;
      } else if (input.source.kind === "data_url") {
        byteSize = input.source.dataUrl.length;
      } else if (input.source.kind === "file_uri") {
        byteSize = input.source.uri.length;
      } else {
        byteSize = input.source.bytes.byteLength;
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize,
        createdAt: 1700000000000 + sequence,
      };
    },
    async encodeBase64() {
      throw new Error("not used in this test");
    },
    async resolvePreviewUrl() {
      throw new Error("not used in this test");
    },
    async delete() {},
    async garbageCollect() {},
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(createTestStore());
});

afterEach(() => {
  __setAttachmentStoreForTests(null);
});

describe("collectImageFilesFromClipboardData", () => {
  it("returns only image files from clipboard items", () => {
    const imagePng = new File([new Uint8Array([0, 1, 2, 3])], "paste.png", {
      type: "image/png",
    });
    const textFile = new File(["not image"], "notes.txt", {
      type: "text/plain",
    });

    const files = collectImageFilesFromClipboardData({
      items: [
        createClipboardItem({ kind: "string", type: "text/plain" }),
        createClipboardItem({
          kind: "file",
          type: "text/plain",
          file: textFile,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/png",
          file: imagePng,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/jpeg",
          file: null,
        }),
      ],
    });

    expect(files).toEqual([{ file: imagePng, mimeType: "image/png" }]);
  });

  it("ignores SVG clipboard files", () => {
    const svgFile = new File(["<svg />"], "logo.svg", {
      type: "image/svg+xml",
    });

    const files = collectImageFilesFromClipboardData({
      items: [
        createClipboardItem({
          kind: "file",
          type: "image/svg+xml",
          file: svgFile,
        }),
      ],
    });

    expect(files).toEqual([]);
  });

  it("detects file-backed image candidates even when Chromium supplies no usable MIME type", () => {
    expect(
      clipboardDataMayContainImage({
        items: [createClipboardItem({ kind: "file", type: "" })],
      }),
    ).toBe(true);
    expect(
      clipboardDataMayContainImage({
        items: [createClipboardItem({ kind: "string", type: "text/plain" })],
      }),
    ).toBe(false);
  });

  it("returns an empty array when clipboard data is missing", () => {
    expect(collectImageFilesFromClipboardData(undefined)).toEqual([]);
    expect(clipboardDataMayContainImage(undefined)).toBe(false);
  });
});

describe("filesToImageAttachments", () => {
  it("persists files as attachment metadata in order", async () => {
    const pngFile = new File([new Uint8Array([0, 1, 2, 3])], "first.png", {
      type: "image/png",
    });
    const typeLessFile = new File([new Uint8Array([4, 5, 6, 7])], "second", {
      type: "",
    });

    const attachments = await filesToImageAttachments([
      { file: pngFile, mimeType: "image/png" },
      { file: typeLessFile, mimeType: "image/png" },
    ]);

    expect(attachments).toEqual([
      {
        id: "att-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-1",
        fileName: "first.png",
        byteSize: 4,
        createdAt: 1700000000001,
      },
      {
        id: "att-2",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-2",
        fileName: "second",
        byteSize: 4,
        createdAt: 1700000000002,
      },
    ]);
  });

  it("handles large files without creating data URLs", async () => {
    const large = new File([new Uint8Array(4 * 1024 * 1024)], "large.png", {
      type: "image/png",
    });

    const [attachment] = await filesToImageAttachments([{ file: large, mimeType: "image/png" }]);

    expect(attachment?.storageType).toBe("web-indexeddb");
    expect(attachment?.byteSize).toBe(4 * 1024 * 1024);
  });

  it("rolls back successfully persisted siblings when one pasted image fails", async () => {
    const deletedIds: string[] = [];
    let saves = 0;
    __setAttachmentStoreForTests({
      ...createTestStore(),
      async save(input) {
        saves += 1;
        if (saves === 2) {
          throw new Error("disk full");
        }
        return {
          id: "persisted-before-failure",
          mimeType: input.mimeType ?? "image/png",
          storageType: "web-indexeddb",
          storageKey: "persisted-before-failure",
          fileName: input.fileName,
          byteSize: 4,
          createdAt: 1700000000001,
        };
      },
      async delete({ attachment }) {
        deletedIds.push(attachment.id);
      },
    });
    const first = new File([new Uint8Array([1])], "first.png", { type: "image/png" });
    const second = new File([new Uint8Array([2])], "second.png", { type: "image/png" });

    await expect(
      filesToImageAttachments([
        { file: first, mimeType: "image/png" },
        { file: second, mimeType: "image/png" },
      ]),
    ).rejects.toThrow("Failed to persist pasted image attachments");
    expect(deletedIds).toEqual(["persisted-before-failure"]);
  });

  it("persists Electron's native clipboard image as a canonical PNG", async () => {
    const attachment = await readCanonicalDesktopClipboardImage(
      async () => "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(attachment).toMatchObject({
      mimeType: "image/png",
      fileName: "clipboard.png",
    });
  });

  it("falls back to Chromium's pasted file if the native clipboard bridge fails", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "fallback.png", {
      type: "image/png",
    });
    const attachments = await persistClipboardImageCandidates({
      files: [{ file, mimeType: "image/png" }],
      readCanonicalImage: async () => {
        throw new Error("IPC unavailable");
      },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("fallback.png");
  });

  it("marks paste processing pending until persistence settles", async () => {
    let resolvePersistence: (value: string) => void = () => undefined;
    const persistence = new Promise<string>((resolve) => {
      resolvePersistence = resolve;
    });
    const changes: number[] = [];
    const result = withImagePastePending({
      onPendingChange: (delta) => changes.push(delta),
      operation: () => persistence,
    });

    expect(changes).toEqual([1]);
    resolvePersistence("saved");
    await expect(result).resolves.toBe("saved");
    expect(changes).toEqual([1, -1]);
  });
});
