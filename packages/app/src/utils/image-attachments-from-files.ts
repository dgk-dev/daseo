import type { AttachmentMetadata } from "@/attachments/types";
import {
  deleteAttachments,
  persistAttachmentFromBlob,
  persistAttachmentFromDataUrl,
} from "@/attachments/service";
import { resolveRasterImageMimeType } from "@/attachments/file-types";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export function clipboardDataMayContainImage(clipboardData?: ClipboardDataLike | null): boolean {
  if (!clipboardData?.items) {
    return false;
  }
  return Array.from(clipboardData.items).some(
    (item) => item?.kind === "file" || item?.type?.trim().toLowerCase().startsWith("image/"),
  );
}

export function collectImageFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null,
): ClipboardImageFile[] {
  if (!clipboardData?.items) {
    return [];
  }

  const files: ClipboardImageFile[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    const mimeType = resolveRasterImageMimeType({ mimeType: item.type });
    if (!mimeType) {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    files.push({ file, mimeType });
  }

  return files;
}

export async function filesToImageAttachments(
  files: readonly ClipboardImageFile[],
): Promise<ImageAttachmentFromFile[]> {
  const results = await Promise.allSettled(
    files.map(async ({ file, mimeType }) =>
      persistAttachmentFromBlob({
        blob: file,
        mimeType,
        fileName: file.name,
      }),
    ),
  );
  const attachments = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    await deleteAttachments(attachments);
    throw new AggregateError(failures, "Failed to persist pasted image attachments.");
  }
  return attachments;
}

export async function readCanonicalDesktopClipboardImage(
  readImage: (() => Promise<string | null>) | undefined,
): Promise<ImageAttachmentFromFile | null> {
  if (!readImage) {
    return null;
  }
  const dataUrl = await readImage();
  if (!dataUrl) {
    return null;
  }
  return await persistAttachmentFromDataUrl({
    dataUrl,
    mimeType: "image/png",
    fileName: "clipboard.png",
  });
}

export async function withImagePastePending<T>(input: {
  onPendingChange?: (delta: 1 | -1) => void;
  operation: () => Promise<T>;
}): Promise<T> {
  input.onPendingChange?.(1);
  try {
    return await input.operation();
  } finally {
    input.onPendingChange?.(-1);
  }
}

export async function persistClipboardImageCandidates(input: {
  files: readonly ClipboardImageFile[];
  readCanonicalImage?: () => Promise<string | null>;
}): Promise<ImageAttachmentFromFile[]> {
  let canonicalReadError: unknown;
  if (input.readCanonicalImage) {
    try {
      const canonical = await readCanonicalDesktopClipboardImage(input.readCanonicalImage);
      if (canonical) {
        return [canonical];
      }
    } catch (error) {
      canonicalReadError = error;
    }
  }
  if (input.files.length > 0) {
    return await filesToImageAttachments(input.files);
  }
  if (canonicalReadError) {
    throw canonicalReadError;
  }
  throw new Error("No readable image data was found in the clipboard.");
}
