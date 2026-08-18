import { resolveRasterImageMimeType } from "@/attachments/file-types";
import {
  normalizePickedImageAssets,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";

export interface NativePastedFile {
  fileName: string;
  fileSize: number;
  type: string;
  uri: string;
}

export class UnsupportedPastedImageError extends Error {
  constructor(fileName: string) {
    super(`Unsupported pasted image '${fileName}'.`);
    this.name = "UnsupportedPastedImageError";
  }
}

export async function normalizeNativePastedImages(
  files: readonly NativePastedFile[],
): Promise<PickedImageAttachmentInput[]> {
  for (const file of files) {
    if (
      !resolveRasterImageMimeType({
        mimeType: file.type,
        path: file.fileName,
      })
    ) {
      throw new UnsupportedPastedImageError(file.fileName);
    }
  }
  return await normalizePickedImageAssets(
    files.map((file) => ({
      uri: file.uri,
      mimeType: file.type,
      fileName: file.fileName,
    })),
  );
}
