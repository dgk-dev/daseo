import { encodeAttachmentsForSend } from "@/attachments/service";
import { getAttachmentStore } from "@/attachments/store";
import { createImageThumbnail } from "@/attachments/image-thumbnail";
import { hostUploadThumbnails } from "@/attachments/host-upload-thumbnails";
import type { AttachmentMetadata, HostUploadReference } from "@/attachments/types";
import { uploadEncodedImages } from "@/composer/actions";
import { composerActivity } from "@/composer/draft-sync/composer-activity";
import { ComposerDraftSync, type ComposerDraftSyncClient } from "@/composer/draft-sync/draft-sync";
import { useDraftStore, waitForDraftStoreHydration } from "@/stores/draft-store";
import { toDraftInputIfReady } from "@/stores/draft-store/state";
import { generateMessageId } from "@/types/stream";

/**
 * Daseo delta 139: the attach-time upload of a synced draft's image. The bytes are the ones a send
 * would upload (the same encoding), so a later send passes only the upload id. The thumbnail is
 * stored once next to the upload; the draft keeps only its size and type.
 */
async function uploadDraftImage(
  client: ComposerDraftSyncClient,
  attachment: AttachmentMetadata,
): Promise<HostUploadReference> {
  const image = (await encodeAttachmentsForSend([attachment]))?.[0];
  if (!image) throw new Error("The image could not be read.");
  const [upload] = await uploadEncodedImages({ client, images: [image] });
  if (!upload) throw new Error("Image upload failed.");
  let thumbnail: HostUploadReference["thumbnail"] = null;
  try {
    const made = await createImageThumbnail({ attachment, store: await getAttachmentStore() });
    await client.setComposerDraftThumbnail({ uploadId: upload.uploadId, thumbnail: made });
    thumbnail = { mimeType: made.mimeType, width: made.width, height: made.height };
  } catch (error) {
    console.warn("[ComposerDraftSync] thumbnail failed; other devices show no preview", error);
  }
  return { uploadId: upload.uploadId, mimeType: upload.mimeType, thumbnail };
}

export const composerDraftSync = new ComposerDraftSync({
  clientId: `draft-sync-${generateMessageId()}`,
  readLocal: (draftKey) => {
    const record = useDraftStore.getState().drafts[draftKey];
    return { draft: toDraftInputIfReady(record), updatedAt: record?.updatedAt ?? 0 };
  },
  listLocalKeys: () => Object.keys(useDraftStore.getState().drafts),
  applyRemote: (draftKey, draft) => {
    useDraftStore.getState().applySyncedDraftInput({ draftKey, draft });
  },
  attachHostUpload: (draftKey, attachmentId, hostUpload) => {
    useDraftStore.getState().attachHostUploadToDraftImage({ draftKey, attachmentId, hostUpload });
  },
  subscribeLocal: (listener) =>
    useDraftStore.subscribe((state, previous) => {
      if (state.drafts === previous.drafts) return;
      const changed: string[] = [];
      for (const draftKey of new Set([
        ...Object.keys(state.drafts),
        ...Object.keys(previous.drafts),
      ])) {
        if (state.drafts[draftKey] !== previous.drafts[draftKey]) changed.push(draftKey);
      }
      if (changed.length > 0) listener(changed);
    }),
  whenLocalReady: waitForDraftStoreHydration,
  activity: composerActivity,
  registerThumbnailSource: (serverId, fetcher) => hostUploadThumbnails.register(serverId, fetcher),
  uploadImage: uploadDraftImage,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  warn: (message, error) => console.warn(message, error),
});
