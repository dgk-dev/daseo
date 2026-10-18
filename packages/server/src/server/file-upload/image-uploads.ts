import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ImageUploadReference {
  uploadId: string;
  mimeType: string;
}

export interface InlineImage {
  data: string;
  mimeType: string;
}

const UPLOAD_ID_PATTERN = /^upload_[A-Za-z0-9._-]+$/;

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
    if (!UPLOAD_ID_PATTERN.test(upload.uploadId) || upload.uploadId.includes("..")) {
      throw new Error(`Invalid image upload id: ${upload.uploadId}`);
    }
    if (!upload.mimeType.startsWith("image/")) {
      throw new Error(`Image upload ${upload.uploadId} is not an image (${upload.mimeType}).`);
    }
    const uploadDir = join(input.paseoHome, "uploads", upload.uploadId);
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

export function mergeInlineImages(
  inline: readonly InlineImage[] | undefined,
  uploaded: readonly InlineImage[],
): InlineImage[] | undefined {
  if (uploaded.length === 0) return inline ? [...inline] : undefined;
  return [...(inline ?? []), ...uploaded];
}
