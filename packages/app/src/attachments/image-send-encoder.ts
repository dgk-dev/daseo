import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { resolveAgentImageMimeType } from "@/attachments/file-types";

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
