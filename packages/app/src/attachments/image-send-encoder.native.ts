import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import {
  IMAGE_REENCODE_MAX_DIMENSION,
  IMAGE_REENCODE_THRESHOLD_BYTES,
} from "@/attachments/image-budget";
import { resolveAgentImageMimeType } from "@/attachments/file-types";

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
    const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.82 });
    return { data: await readAndDelete(result.uri), mimeType: "image/jpeg" };
  } finally {
    image.release();
    context.release();
  }
}
