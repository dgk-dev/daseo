import { describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import {
  prepareImageAttachmentWith,
  UnconvertibleImageError,
  type ImagePreparationPlatform,
} from "./image-send-encoder-prepare";
import { MAX_IMAGE_PIXELS } from "./image-budget";

function attachment(input: Partial<AttachmentMetadata>): AttachmentMetadata {
  return {
    id: input.id ?? "att",
    mimeType: input.mimeType ?? "image/png",
    storageType: "native-file",
    storageKey: "/tmp/att",
    fileName: input.fileName ?? null,
    byteSize: input.byteSize ?? 1024,
    createdAt: 1,
  };
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function recordingStore(): AttachmentStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    storageType: "native-file",
    deleted,
    async save() {
      throw new Error("not used");
    },
    async encodeBase64() {
      return "";
    },
    async resolvePreviewUrl() {
      return "";
    },
    async delete({ attachment: removed }) {
      deleted.push(removed.id);
    },
    async garbageCollect() {},
  };
}

function platform(input: {
  header: Uint8Array | null;
  convert?: ImagePreparationPlatform["convertToJpeg"];
}): ImagePreparationPlatform & { decodes: string[] } {
  const decodes: string[] = [];
  return {
    decodes,
    readHeader: async () => input.header,
    convertToJpeg: async (args) => {
      decodes.push(args.attachment.id);
      if (!input.convert) throw new Error("cannot decode");
      return await input.convert(args);
    },
  };
}

describe("prepareImageAttachmentWith", () => {
  it("refuses a pasted image whose header exceeds the pixel budget before anything decodes it", async () => {
    const io = platform({ header: pngHeader(10_000, 10_000) });

    await expect(
      prepareImageAttachmentWith(io, {
        attachment: attachment({ id: "pasted", fileName: "paste.png" }),
        store: recordingStore(),
      }),
    ).rejects.toThrow(`paste.png is 10000×10000; the decoded-pixel safety limit`);
    expect(io.decodes).toEqual([]);
    expect(10_000 * 10_000).toBeGreaterThan(MAX_IMAGE_PIXELS);
  });

  it("keeps an agent format as it is", async () => {
    const source = attachment({ id: "photo", mimeType: "image/jpeg" });
    const io = platform({ header: pngHeader(100, 100) });

    await expect(
      prepareImageAttachmentWith(io, { attachment: source, store: recordingStore() }),
    ).resolves.toBe(source);
    expect(io.decodes).toEqual([]);
  });

  it("converts HEIC to JPEG and replaces the stored original", async () => {
    const store = recordingStore();
    const converted = attachment({ id: "converted", mimeType: "image/jpeg" });
    let requestedName: string | null = null;
    const io = platform({
      header: null,
      convert: async ({ fileName }) => {
        requestedName = fileName;
        return converted;
      },
    });

    await expect(
      prepareImageAttachmentWith(io, {
        attachment: attachment({ id: "heic", mimeType: "image/heic", fileName: "IMG_1.HEIC" }),
        store,
      }),
    ).resolves.toBe(converted);
    expect(requestedName).toBe("IMG_1.jpg");
    expect(store.deleted).toEqual(["heic"]);
  });

  it("refuses a format the device cannot decode with a reason, keeping the stored copy for the caller", async () => {
    const store = recordingStore();
    const io = platform({ header: null });

    const result = prepareImageAttachmentWith(io, {
      attachment: attachment({ id: "tiff", mimeType: "image/tiff", fileName: "scan.tiff" }),
      store,
    });

    await expect(result).rejects.toBeInstanceOf(UnconvertibleImageError);
    await expect(result).rejects.toThrow(
      "scan.tiff is a TIFF image, which this device can't convert for the agent. Save it as JPEG or PNG and attach it again.",
    );
    expect(store.deleted).toEqual([]);
  });
});
