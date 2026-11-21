import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { AttachmentMetadata, AttachmentStore, HostUploadThumbnail } from "@/attachments/types";
import {
  THUMBNAIL_JPEG_QUALITY,
  THUMBNAIL_MAX_DIMENSION,
} from "@/attachments/image-thumbnail-size";

function attachmentUri(attachment: AttachmentMetadata): string {
  return attachment.storageKey.startsWith("file://")
    ? attachment.storageKey
    : `file://${attachment.storageKey}`;
}

/** Native: renders the stored image at most 256 px on the long side and keeps the JPEG in memory. */
export async function createImageThumbnail(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
}): Promise<HostUploadThumbnail> {
  const uri = attachmentUri(input.attachment);
  let context = ImageManipulator.manipulate(uri);
  let image = await context.renderAsync();
  try {
    if (Math.max(image.width, image.height) > THUMBNAIL_MAX_DIMENSION) {
      const landscape = image.width >= image.height;
      image.release();
      context.release();
      context = ImageManipulator.manipulate(uri);
      context.resize(
        landscape ? { width: THUMBNAIL_MAX_DIMENSION } : { height: THUMBNAIL_MAX_DIMENSION },
      );
      image = await context.renderAsync();
    }
    const result = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: THUMBNAIL_JPEG_QUALITY,
      base64: true,
    });
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
    if (!result.base64) throw new Error("The thumbnail was not encoded.");
    return {
      data: result.base64,
      mimeType: "image/jpeg",
      width: result.width,
      height: result.height,
    };
  } finally {
    image.release();
    context.release();
  }
}
