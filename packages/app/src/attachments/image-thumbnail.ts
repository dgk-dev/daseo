import type { AttachmentMetadata, AttachmentStore, HostUploadThumbnail } from "@/attachments/types";

import { fitThumbnailSize, THUMBNAIL_JPEG_QUALITY } from "@/attachments/image-thumbnail-size";

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function drawJpeg(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  const draw = (context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
  };
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas context.");
    draw(context);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: THUMBNAIL_JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas context.");
  draw(context);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("Canvas JPEG encoding failed."));
      },
      "image/jpeg",
      THUMBNAIL_JPEG_QUALITY,
    );
  });
}

/** Web and desktop: decodes the stored image and draws it at most 256 px on the long side. */
export async function createImageThumbnail(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
}): Promise<HostUploadThumbnail> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This runtime cannot decode images.");
  }
  const bytes = base64ToBytes(await input.store.encodeBase64({ attachment: input.attachment }));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: input.attachment.mimeType }));
  try {
    const size = fitThumbnailSize({ width: bitmap.width, height: bitmap.height });
    const jpeg = await drawJpeg(bitmap, size.width, size.height);
    return { data: await blobToBase64(jpeg), mimeType: "image/jpeg", ...size };
  } finally {
    bitmap.close();
  }
}
