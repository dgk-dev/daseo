import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import {
  IMAGE_HEADER_PROBE_BYTES,
  IMAGE_REENCODE_MAX_DIMENSION,
  IMAGE_REENCODE_THRESHOLD_BYTES,
} from "@/attachments/image-budget";
import { resolveAgentImageMimeType } from "@/attachments/file-types";
import { prepareImageAttachmentWith } from "@/attachments/image-send-encoder-prepare";
import {
  chooseOversizedImageFormats,
  isAnimatedGifHeader,
} from "@/attachments/image-send-encoder-formats";

function attachmentUri(attachment: AttachmentMetadata): string {
  return attachment.storageKey.startsWith("file://")
    ? attachment.storageKey
    : `file://${attachment.storageKey}`;
}

async function readAndDelete(uri: string): Promise<string> {
  try {
    return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}

async function fileSize(uri: string): Promise<number | null> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && typeof info.size === "number" ? info.size : null;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readHeader(attachment: AttachmentMetadata): Promise<Uint8Array> {
  const uri = attachmentUri(attachment);
  const size = await fileSize(uri);
  const length = size == null ? IMAGE_HEADER_PROBE_BYTES : Math.min(size, IMAGE_HEADER_PROBE_BYTES);
  return base64ToBytes(
    await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length,
    }),
  );
}

async function convertToJpeg(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
  fileName: string | null;
}): Promise<AttachmentMetadata> {
  const context = ImageManipulator.manipulate(attachmentUri(input.attachment));
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  let outputUri: string | null = null;
  try {
    image = await context.renderAsync();
    outputUri = (await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 })).uri;
    return await input.store.save({
      mimeType: "image/jpeg",
      fileName: input.fileName,
      source: { kind: "file_uri", uri: outputUri },
    });
  } finally {
    image?.release();
    context.release();
    if (outputUri) await FileSystem.deleteAsync(outputUri, { idempotent: true }).catch(() => {});
  }
}

/**
 * Native: every attached image gets its pixel size read from the file header before anything
 * decodes it (pasted images arrive without width and height), and HEIC, HEIF, AVIF, BMP and
 * TIFF are decoded once here and stored as JPEG.
 */
export async function prepareImageAttachmentForAgent(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
}): Promise<AttachmentMetadata> {
  return await prepareImageAttachmentWith({ readHeader, convertToJpeg }, input);
}

/**
 * Attachments whose animation is lost at send: an animated GIF over the send limit is
 * re-encoded from its first frame. The composer tells the user before sending.
 */
export async function findAnimatedGifsSentAsStill(
  attachments: readonly AttachmentMetadata[],
): Promise<AttachmentMetadata[]> {
  const stills: AttachmentMetadata[] = [];
  for (const attachment of attachments) {
    if (resolveAgentImageMimeType(attachment.mimeType) !== "image/gif") continue;
    if (attachment.byteSize == null || attachment.byteSize <= IMAGE_REENCODE_THRESHOLD_BYTES) {
      continue;
    }
    const header = await readHeader(attachment).catch(() => null);
    if (header && isAnimatedGifHeader(header)) stills.push(attachment);
  }
  return stills;
}

export async function encodeImageAttachmentForSend(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
}): Promise<{ data: string; mimeType: string }> {
  const mimeType = resolveAgentImageMimeType(input.attachment.mimeType);
  if (!mimeType) {
    throw new Error(
      `Unsupported image format '${input.attachment.mimeType}'. Use PNG, JPEG, GIF, or WebP.`,
    );
  }
  if (
    input.attachment.byteSize == null ||
    input.attachment.byteSize <= IMAGE_REENCODE_THRESHOLD_BYTES
  ) {
    return {
      data: await input.store.encodeBase64({ attachment: input.attachment }),
      mimeType,
    };
  }

  const sourceUri = attachmentUri(input.attachment);
  let context = ImageManipulator.manipulate(sourceUri);
  let image = await context.renderAsync();
  try {
    const sourceWidth = image.width;
    const sourceHeight = image.height;
    const largestDimension = Math.max(sourceWidth, sourceHeight);
    if (largestDimension > IMAGE_REENCODE_MAX_DIMENSION) {
      image.release();
      context.release();
      context = ImageManipulator.manipulate(sourceUri);
      if (sourceWidth >= sourceHeight) context.resize({ width: IMAGE_REENCODE_MAX_DIMENSION });
      else context.resize({ height: IMAGE_REENCODE_MAX_DIMENSION });
      image = await context.renderAsync();
    }
    // Formats that can carry transparency are tried as PNG first so the alpha survives; JPEG
    // only when the PNG is still over the limit. A GIF renders its first frame (a still).
    for (const format of chooseOversizedImageFormats(mimeType)) {
      const result = await image.saveAsync(
        format === "png" ? { format: SaveFormat.PNG } : { format: SaveFormat.JPEG, compress: 0.82 },
      );
      const size = format === "png" ? await fileSize(result.uri) : null;
      if (format === "png" && (size == null || size > IMAGE_REENCODE_THRESHOLD_BYTES)) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
        continue;
      }
      return {
        data: await readAndDelete(result.uri),
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      };
    }
    throw new Error("No image format fit the send limit.");
  } finally {
    image.release();
    context.release();
  }
}
