import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { getAttachmentStore } from "@/attachments/store";
import { hostUploadThumbnails } from "@/attachments/host-upload-thumbnails";
import type { AttachmentMetadata, SaveAttachmentInput } from "@/attachments/types";
import {
  encodeImageAttachmentForSend,
  findAnimatedGifsSentAsStill,
  prepareImageAttachmentForAgent,
} from "@/attachments/image-send-encoder";
import { assertImageSourceBudget, estimateDataUrlBytes } from "@/attachments/image-budget";

const activePersistence = new Set<Promise<AttachmentMetadata>>();
const persistedDuringGarbageCollection = new Set<string>();
let pendingGarbageCollections = 0;
let garbageCollectionTail: Promise<void> = Promise.resolve();
let persistenceBarrier: Promise<void> | null = null;
let releasePersistenceBarrier: (() => void) | null = null;

function sourceByteSize(input: SaveAttachmentInput): number | null {
  if (input.source.kind === "blob") return input.source.blob.size;
  if (input.source.kind === "bytes") return input.source.bytes.byteLength;
  if (input.source.kind === "data_url") return estimateDataUrlBytes(input.source.dataUrl);
  return null;
}

async function waitForPersistenceBarrier(): Promise<void> {
  const barrier = persistenceBarrier;
  if (!barrier) {
    return;
  }
  await barrier;
  await waitForPersistenceBarrier();
}

async function persistAttachment(input: SaveAttachmentInput): Promise<AttachmentMetadata> {
  assertImageSourceBudget({ byteSize: sourceByteSize(input), label: input.fileName });
  await waitForPersistenceBarrier();
  const pending = (async () => {
    const store = await getAttachmentStore();
    const saved = await store.save(input);
    let attachment: AttachmentMetadata;
    try {
      assertImageSourceBudget({ byteSize: saved.byteSize, label: saved.fileName });
      // Pixel check from the header and conversion of formats the agent does not take, so an
      // attached image never fails later at send.
      attachment = await prepareImageAttachmentForAgent({ attachment: saved, store });
    } catch (error) {
      await store.delete({ attachment: saved }).catch(() => undefined);
      throw error;
    }
    if (pendingGarbageCollections > 0) {
      persistedDuringGarbageCollection.add(attachment.id);
    }
    return attachment;
  })();
  activePersistence.add(pending);
  try {
    return await pending;
  } finally {
    activePersistence.delete(pending);
  }
}

export async function persistAttachmentFromBlob(input: {
  blob: Blob;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "blob", blob: input.blob },
  });
}

export async function persistAttachmentFromDataUrl(input: {
  dataUrl: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "data_url", dataUrl: input.dataUrl },
  });
}

export async function persistAttachmentFromBytes(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "bytes", bytes: input.bytes },
  });
}

export async function persistAttachmentFromFileUri(input: {
  uri: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "file_uri", uri: input.uri },
  });
}

export async function encodeAttachmentsForSend(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const store = await getAttachmentStore();
  return await Promise.all(
    attachments.map(async (attachment) => {
      try {
        if (attachment.storageType === "host-upload") {
          // Sent by upload id (delta 139); only a host without image uploads would land here.
          throw new Error("This image is stored on the host. Update Paseo on the host to send it.");
        }
        const encoded = await encodeImageAttachmentForSend({ attachment, store });
        if (!encoded.data.trim()) {
          throw new Error("Attachment bytes are empty.");
        }
        return encoded;
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new Error(
          `Failed to read image attachment '${attachment.fileName ?? attachment.id}'. The message was not sent.${detail}`,
          { cause: error },
        );
      }
    }),
  );
}

/**
 * Image attachments that will lose their animation at send (an animated GIF over the send
 * limit goes out as its first frame). Empty where images are sent as they are.
 */
export async function findAttachmentsSentAsStill(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<AttachmentMetadata[]> {
  if (!attachments || attachments.length === 0) return [];
  return await findAnimatedGifsSentAsStill(attachments);
}

export async function resolveAttachmentPreviewUrl(attachment: AttachmentMetadata): Promise<string> {
  if (attachment.storageType === "host-upload") {
    // Daseo delta 139: an image attached on another device previews as its thumbnail, fetched
    // from the host once per upload and cached.
    const upload = attachment.hostUpload;
    if (!upload?.thumbnail || !upload.serverId) {
      throw new Error("This image was attached on another device without a preview.");
    }
    return await hostUploadThumbnails.resolve({
      serverId: upload.serverId,
      uploadId: upload.uploadId,
    });
  }
  const store = await getAttachmentStore();
  return await store.resolvePreviewUrl({ attachment });
}

export async function releaseAttachmentPreviewUrl(input: {
  attachment: AttachmentMetadata;
  url: string;
}): Promise<void> {
  if (input.attachment.storageType === "host-upload") return;
  const store = await getAttachmentStore();
  if (!store.releasePreviewUrl) {
    return;
  }
  await store.releasePreviewUrl({ attachment: input.attachment, url: input.url });
}

export async function deleteAttachments(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<void> {
  // Bytes of an image attached on another device live on the host, not in this device's store.
  const local = attachments?.filter((attachment) => attachment.storageType !== "host-upload");
  if (!local || local.length === 0) {
    return;
  }
  const store = await getAttachmentStore();
  await Promise.all(
    local.map(async (attachment) => {
      try {
        await store.delete({ attachment });
      } catch (error) {
        console.warn("[attachments] Failed to delete attachment", {
          id: attachment.id,
          error,
        });
      }
    }),
  );
}

export async function garbageCollectAttachments(input: {
  referencedIds: ReadonlySet<string>;
}): Promise<void> {
  pendingGarbageCollections += 1;
  if (!persistenceBarrier) {
    persistenceBarrier = new Promise<void>((resolve) => {
      releasePersistenceBarrier = resolve;
    });
  }

  const previousGarbageCollection = garbageCollectionTail;
  const currentGarbageCollection = (async () => {
    await previousGarbageCollection;
    while (activePersistence.size > 0) {
      await Promise.allSettled(activePersistence);
    }
    const referencedIds = new Set(input.referencedIds);
    for (const id of collectRetainedAttachmentIds()) {
      referencedIds.add(id);
    }
    for (const id of persistedDuringGarbageCollection) {
      referencedIds.add(id);
    }
    const store = await getAttachmentStore();
    await store.garbageCollect({ referencedIds });
  })();
  garbageCollectionTail = currentGarbageCollection.catch(() => undefined);

  try {
    await currentGarbageCollection;
  } finally {
    pendingGarbageCollections -= 1;
    if (pendingGarbageCollections === 0) {
      persistedDuringGarbageCollection.clear();
      const release = releasePersistenceBarrier;
      releasePersistenceBarrier = null;
      persistenceBarrier = null;
      release?.();
    }
  }
}
