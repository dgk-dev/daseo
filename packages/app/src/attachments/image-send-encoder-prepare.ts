import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import {
  assertImageSourceBudget,
  imageFallbackLabel,
  readImageDimensions,
} from "@/attachments/image-budget";
import { i18n } from "@/i18n/i18next";
import { resolveAgentImageMimeType } from "@/attachments/file-types";

/** Platform I/O for {@link prepareImageAttachmentWith}; the web and native encoders supply it. */
export interface ImagePreparationPlatform {
  /**
   * First bytes of the stored image, for the pixel check, or null when this platform does not
   * check this image before decoding it.
   */
  readHeader(attachment: AttachmentMetadata): Promise<Uint8Array | null>;
  /** Decodes the stored image and stores it again as JPEG. Throws when it cannot decode it. */
  convertToJpeg(input: {
    attachment: AttachmentMetadata;
    store: AttachmentStore;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

const FORMAT_LABEL_BY_MIME_TYPE: Record<string, string> = {
  "image/heic": "HEIC",
  "image/heif": "HEIF",
  "image/avif": "AVIF",
  "image/bmp": "BMP",
  "image/tiff": "TIFF",
};

export class UnconvertibleImageError extends Error {
  constructor(label: string, mimeType: string, options?: { cause?: unknown }) {
    const format = FORMAT_LABEL_BY_MIME_TYPE[mimeType] ?? mimeType;
    super(
      i18n.t("attachments.imageErrors.unconvertible", {
        defaultValue:
          "{{label}} is a {{format}} image, which this device can't convert for the agent. Save it as JPEG or PNG and attach it again.",
        label,
        format,
      }),
      options,
    );
    this.name = "UnconvertibleImageError";
  }
}

function jpegFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  return `${fileName.replace(/\.[^./\\]+$/, "")}.jpg`;
}

/**
 * Runs when an image is attached, before anything decodes it: checks its pixel size from the
 * header, then turns a format the agent does not take (HEIC, HEIF, AVIF, BMP, TIFF) into JPEG.
 * An image that cannot be converted is refused here, at attach time, so no attached image fails
 * later at send. On success the original stored copy is replaced by the converted one.
 */
export async function prepareImageAttachmentWith(
  platform: ImagePreparationPlatform,
  input: { attachment: AttachmentMetadata; store: AttachmentStore },
): Promise<AttachmentMetadata> {
  const { attachment, store } = input;
  const label = attachment.fileName?.trim() || imageFallbackLabel();
  const header = await platform.readHeader(attachment).catch(() => null);
  const size = header ? readImageDimensions(header) : null;
  assertImageSourceBudget({
    byteSize: attachment.byteSize,
    width: size?.width,
    height: size?.height,
    label,
  });
  if (resolveAgentImageMimeType(attachment.mimeType)) {
    return attachment;
  }

  let converted: AttachmentMetadata;
  try {
    converted = await platform.convertToJpeg({
      attachment,
      store,
      fileName: jpegFileName(attachment.fileName),
    });
  } catch (error) {
    throw new UnconvertibleImageError(label, attachment.mimeType, { cause: error });
  }
  await store.delete({ attachment }).catch(() => undefined);
  return converted;
}
