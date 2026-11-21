import type { ComposerDraftAttachment } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { UserComposerAttachmentSchema, type DraftInput } from "@/stores/draft-store/state";

/**
 * Daseo delta 139: maps a chat draft between this app's draft store and the daemon's synced draft.
 *
 * - An image goes as its upload reference and its thumbnail's size and type (the thumbnail bytes
 *   stay on the host, fetched once by upload id). An image still being uploaded (or whose upload
 *   failed) stays on this device only: it is not sent and is kept when another device's draft is
 *   applied here.
 * - An uploaded file goes with its upload id, so the host keeps the upload while the draft lives.
 * - Every other attachment goes as its own JSON; a kind this app does not know is dropped.
 */
export interface WireDraft {
  text: string;
  attachments: ComposerDraftAttachment[];
}

export function isLocalOnlyImage(attachment: UserComposerAttachment): boolean {
  return attachment.kind === "image" && !attachment.metadata.hostUpload;
}

function toWireAttachment(
  attachment: UserComposerAttachment,
  index: number,
): ComposerDraftAttachment | null {
  if (attachment.kind === "image") {
    const { metadata } = attachment;
    if (!metadata.hostUpload) return null;
    return {
      id: metadata.id,
      kind: "image",
      uploadId: metadata.hostUpload.uploadId,
      fileName: metadata.fileName ?? null,
      mimeType: metadata.hostUpload.mimeType,
      size: metadata.byteSize ?? null,
      thumbnail: metadata.hostUpload.thumbnail,
    };
  }
  if (attachment.kind === "file") {
    return {
      id: attachment.attachment.id,
      kind: "file",
      uploadId: attachment.attachment.id,
      fileName: attachment.attachment.fileName,
      mimeType: attachment.attachment.mimeType,
      size: attachment.attachment.size,
      data: JSON.stringify(attachment),
    };
  }
  return {
    id: `${attachment.kind}:${index}`,
    kind: attachment.kind,
    data: JSON.stringify(attachment),
  };
}

export function toWireDraft(draft: DraftInput): WireDraft {
  return {
    text: draft.text,
    attachments: draft.attachments.flatMap((attachment, index) => {
      const wire = toWireAttachment(attachment, index);
      return wire ? [wire] : [];
    }),
  };
}

/** A stable comparison key for "is this the same synced content". */
export function wireDraftKey(draft: WireDraft): string {
  return JSON.stringify([draft.text, draft.attachments]);
}

export function isEmptyWireDraft(draft: WireDraft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

function parseAttachmentData(data: string | null | undefined): UserComposerAttachment | null {
  if (!data) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = UserComposerAttachmentSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function fromWireImage(
  wire: ComposerDraftAttachment,
  local: readonly UserComposerAttachment[],
  serverId: string,
): UserComposerAttachment | null {
  if (!wire.uploadId || !wire.mimeType) return null;
  // The device that attached the image keeps its own copy, which has the bytes.
  const own = local.find(
    (attachment) => attachment.kind === "image" && attachment.metadata.id === wire.id,
  );
  if (own?.kind === "image" && own.metadata.hostUpload?.uploadId === wire.uploadId) return own;
  const metadata: AttachmentMetadata = {
    id: wire.id,
    mimeType: wire.mimeType,
    storageType: "host-upload",
    storageKey: wire.uploadId,
    fileName: wire.fileName ?? null,
    byteSize: wire.size ?? null,
    createdAt: 0,
    hostUpload: {
      uploadId: wire.uploadId,
      mimeType: wire.mimeType,
      thumbnail: wire.thumbnail ?? null,
      serverId,
    },
  };
  return { kind: "image", metadata };
}

/**
 * The draft to show for a synced draft from `serverId`'s daemon. `local` is this device's current
 * draft: its own image copies are reused, and its images not yet on the host are kept at the end.
 */
export function fromWireDraft(
  wire: WireDraft,
  local: DraftInput | undefined,
  serverId: string,
): DraftInput {
  const localAttachments = local?.attachments ?? [];
  const attachments = wire.attachments.flatMap((attachment) => {
    const parsed =
      attachment.kind === "image"
        ? fromWireImage(attachment, localAttachments, serverId)
        : parseAttachmentData(attachment.data);
    return parsed ? [parsed] : [];
  });
  const syncedIds = new Set(
    attachments.flatMap((attachment) =>
      attachment.kind === "image" ? [attachment.metadata.id] : [],
    ),
  );
  for (const attachment of localAttachments) {
    if (isLocalOnlyImage(attachment) && attachment.kind === "image") {
      if (!syncedIds.has(attachment.metadata.id)) attachments.push(attachment);
    }
  }
  return { text: wire.text, attachments };
}
