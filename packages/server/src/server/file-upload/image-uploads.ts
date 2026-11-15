import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { uploadDirectory } from "./index.js";

export interface ImageUploadReference {
  uploadId: string;
  mimeType: string;
}

export interface InlineImage {
  data: string;
  mimeType: string;
}

/**
 * Reads images the client sent through the chunked file upload and returns them in the
 * inline `images` shape the providers already take. Each upload directory under
 * `<paseoHome>/uploads/<uploadId>` holds exactly the one uploaded file.
 */
export async function readImageUploads(input: {
  paseoHome: string;
  uploads: readonly ImageUploadReference[] | undefined;
}): Promise<InlineImage[]> {
  const images: InlineImage[] = [];
  for (const upload of input.uploads ?? []) {
    let uploadDir: string;
    try {
      uploadDir = uploadDirectory({ paseoHome: input.paseoHome, uploadId: upload.uploadId });
    } catch {
      throw new Error(`Invalid image upload id: ${upload.uploadId}`);
    }
    if (!upload.mimeType.startsWith("image/")) {
      throw new Error(`Image upload ${upload.uploadId} is not an image (${upload.mimeType}).`);
    }
    let entries: string[];
    try {
      entries = await readdir(uploadDir);
    } catch {
      throw new Error("The attached image is no longer on the host. Attach it again.");
    }
    const fileName = entries.find((entry) => !entry.startsWith("."));
    if (!fileName) {
      throw new Error("The attached image is no longer on the host. Attach it again.");
    }
    const bytes = await readFile(join(uploadDir, fileName));
    images.push({ data: bytes.toString("base64"), mimeType: upload.mimeType });
  }
  return images;
}

/**
 * Reads the uploaded images into message bytes, then removes their upload directories: once the
 * bytes are in the message the copies on disk serve nothing. A retried send uploads again (new
 * upload ids, same bytes, same receipt hash). When a read fails nothing is removed; the age
 * sweep collects what is left.
 */
export async function consumeImageUploads(input: {
  paseoHome: string;
  uploads: readonly ImageUploadReference[] | undefined;
}): Promise<InlineImage[]> {
  const images = await readImageUploads(input);
  await Promise.all(
    (input.uploads ?? []).map((upload) =>
      rm(uploadDirectory({ paseoHome: input.paseoHome, uploadId: upload.uploadId }), {
        recursive: true,
        force: true,
      }).catch(() => undefined),
    ),
  );
  return images;
}

export function mergeInlineImages(
  inline: readonly InlineImage[] | undefined,
  uploaded: readonly InlineImage[],
): InlineImage[] | undefined {
  if (uploaded.length === 0) return inline ? [...inline] : undefined;
  return [...(inline ?? []), ...uploaded];
}
