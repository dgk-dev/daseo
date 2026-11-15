import { assertImageSourceBudget } from "@/attachments/image-budget";
import {
  getRasterImageMimeTypeFromPath,
  resolveAgentImageMimeType,
  resolveRasterImageMimeType,
} from "@/attachments/file-types";

export type PickedImageSource = { kind: "file_uri"; uri: string } | { kind: "blob"; blob: Blob };

export interface PickedImageAttachmentInput {
  source: PickedImageSource;
  mimeType: string;
  fileName?: string | null;
}

export interface ExpoImagePickerAssetLike {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  file?: File | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
}

interface PickedImageFormat {
  mimeType: string;
  /** Extension to give the file name when the picker's name disagrees with the content. */
  extension: string | null;
}

const AGENT_FORMAT_BY_MIME_TYPE: Record<string, PickedImageFormat> = {
  "image/jpeg": { mimeType: "image/jpeg", extension: "jpg" },
  "image/png": { mimeType: "image/png", extension: "png" },
  "image/gif": { mimeType: "image/gif", extension: "gif" },
  "image/webp": { mimeType: "image/webp", extension: "webp" },
};

function extensionFromPath(path: string | null | undefined): string | null {
  const match = path?.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function formatForMimeType(mimeType: string | null): PickedImageFormat | null {
  if (!mimeType) return null;
  return AGENT_FORMAT_BY_MIME_TYPE[mimeType] ?? { mimeType, extension: null };
}

/**
 * The content type of a picked file. The URI extension names the bytes Android actually
 * handed over, so a raster extension there wins (a ".heic" URI labelled image/jpeg is HEIC);
 * otherwise the picker's MIME metadata, then the file name.
 */
function pickedAssetFormat(asset: ExpoImagePickerAssetLike): PickedImageFormat | null {
  const uriExtension = extensionFromPath(asset.uri);
  const uriMimeType = uriExtension ? getRasterImageMimeTypeFromPath(`.${uriExtension}`) : null;
  if (uriMimeType && !resolveAgentImageMimeType(uriMimeType)) {
    return formatForMimeType(uriMimeType);
  }
  return (
    formatForMimeType(resolveRasterImageMimeType({ mimeType: asset.mimeType })) ??
    formatForMimeType(resolveRasterImageMimeType({ path: asset.fileName })) ??
    formatForMimeType(uriMimeType)
  );
}

function replaceFileExtension(
  fileName: string | null | undefined,
  extension: string | null,
): string | null {
  if (!fileName) {
    return null;
  }
  if (!extension) {
    return fileName;
  }
  return fileName.replace(/\.[^./\\]+$/, "") + `.${extension}`;
}

/**
 * Native picker and paste intake. Nothing is decoded here: the attachment service reads the
 * pixel size from the stored file's header and converts HEIC, HEIF, AVIF, BMP and TIFF to JPEG
 * when the image is attached. GIF and WebP stay as they are (the agent takes them; a GIF keeps
 * its animation).
 */
export async function normalizePickedImageAssets(
  assets: readonly ExpoImagePickerAssetLike[],
): Promise<PickedImageAttachmentInput[]> {
  return assets.map((asset) => {
    assertImageSourceBudget({
      byteSize: asset.file?.size ?? asset.fileSize,
      width: asset.width,
      height: asset.height,
      label: asset.fileName,
    });
    const format = pickedAssetFormat(asset);
    if (!format) {
      throw new Error(`Unsupported image type for '${asset.fileName ?? asset.uri}'.`);
    }
    return {
      source: { kind: "file_uri", uri: asset.uri },
      mimeType: format.mimeType,
      fileName: replaceFileExtension(asset.fileName, format.extension),
    };
  });
}
