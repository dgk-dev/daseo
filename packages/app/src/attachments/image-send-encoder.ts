import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { resolveAgentImageMimeType } from "@/attachments/file-types";
import { prepareImageAttachmentWith } from "@/attachments/image-send-encoder-prepare";

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
  return {
    data: await input.store.encodeBase64({ attachment: input.attachment }),
    mimeType,
  };
}

/** Web and desktop send images as they are, so no animation is lost. */
export async function findAnimatedGifsSentAsStill(
  _attachments: readonly AttachmentMetadata[],
): Promise<AttachmentMetadata[]> {
  return [];
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readStoredBytes(
  store: AttachmentStore,
  attachment: AttachmentMetadata,
): Promise<Uint8Array<ArrayBuffer>> {
  return base64ToBytes(await store.encodeBase64({ attachment }));
}

async function encodeCanvasAsJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const draw = (context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    // JPEG has no alpha; transparent pixels become white rather than black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
  };
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas context.");
    draw(context);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
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
      0.9,
    );
  });
}

/**
 * Web and desktop: browsers decode BMP and (Chromium) AVIF, so those convert to JPEG here;
 * HEIC, HEIF and TIFF do not decode in Chromium and are refused when attached. The pixel check
 * reads only images that will be decoded here.
 */
export async function prepareImageAttachmentForAgent(input: {
  attachment: AttachmentMetadata;
  store: AttachmentStore;
}): Promise<AttachmentMetadata> {
  return await prepareImageAttachmentWith(
    {
      readHeader: async (attachment) =>
        resolveAgentImageMimeType(attachment.mimeType)
          ? null
          : await readStoredBytes(input.store, attachment),
      convertToJpeg: async ({ attachment, store, fileName }) => {
        if (typeof createImageBitmap !== "function") {
          throw new Error("This runtime cannot decode images.");
        }
        const bytes = await readStoredBytes(store, attachment);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: attachment.mimeType }));
        let jpeg: Blob;
        try {
          jpeg = await encodeCanvasAsJpeg(bitmap);
        } finally {
          bitmap.close();
        }
        return await store.save({
          mimeType: "image/jpeg",
          fileName,
          source: { kind: "blob", blob: jpeg },
        });
      },
    },
    input,
  );
}
