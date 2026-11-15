import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";
import type { AssistantImageSourceResolution } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
} from "./acquisition-cache";
import {
  createAssistantImageSnapshotCacheKey,
  type AssistantImageSnapshotCache,
  type AssistantImageSnapshotCopy,
} from "./snapshot-cache";
import { parseAssistantImageSnapshotPath } from "./snapshot-source";

export interface AssistantImageFileAcquisitionPort {
  readFile(cwd: string, path: string): Promise<FileReadResult>;
  persist(input: {
    id: string;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

/** Copies a snapshot already on this device into the attachment store, without the host. */
export type AssistantImageSnapshotCopyPersister = (input: {
  id: string;
  copy: AssistantImageSnapshotCopy;
  mimeType: string;
  fileName: string | null;
}) => Promise<AttachmentMetadata>;

export interface AssistantImageAcquisition {
  key: string;
  /** Set for a daemon snapshot: the key of its durable copy on this device. */
  snapshotCacheKey?: string;
  locate: () => Promise<AttachmentMetadata>;
}

/**
 * A retry asks for a fresh acquisition: the generation becomes part of the cache key, so the
 * in-memory caches do not hand back the attempt that failed. Generation 0 keeps the old keys.
 */
function withGeneration(key: string, generation: number | undefined): string {
  return generation ? `${key}#retry-${generation}` : key;
}

export function createAssistantImageFileAcquisition(input: {
  port: AssistantImageFileAcquisitionPort | null;
  resolution: AssistantImageSourceResolution | null;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
  generation?: number;
  loadSnapshotCache?: () => Promise<AssistantImageSnapshotCache | null>;
  persistSnapshotCopy?: AssistantImageSnapshotCopyPersister;
}): AssistantImageAcquisition | null {
  if (input.resolution?.kind !== "file_rpc") {
    return null;
  }
  const { port, resolution } = input;
  const snapshot = parseAssistantImageSnapshotPath(resolution.path);
  if (snapshot) {
    return createSnapshotAcquisition({ ...input, resolution, snapshot });
  }
  return {
    key: withGeneration(
      createAssistantImageFileAcquisitionKey({
        serverId: input.serverId,
        occurrenceKey: input.occurrenceKey,
        cwd: resolution.cwd,
        path: resolution.path,
      }),
      input.generation,
    ),
    locate: async () => {
      if (!port) {
        throw new Error(input.unavailableMessage);
      }
      const file = await port.readFile(resolution.cwd, resolution.path);
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      return await port.persist({
        id: createAssistantImageFilePreviewAttachmentId({
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
    },
  };
}

/**
 * A snapshot's bytes never change, so every message showing it shares one acquisition, and a
 * copy kept on this device answers without the host (after an app restart, or offline).
 */
function createSnapshotAcquisition(input: {
  port: AssistantImageFileAcquisitionPort | null;
  resolution: Extract<AssistantImageSourceResolution, { kind: "file_rpc" }>;
  serverId?: string;
  unavailableMessage: string;
  generation?: number;
  loadSnapshotCache?: () => Promise<AssistantImageSnapshotCache | null>;
  persistSnapshotCopy?: AssistantImageSnapshotCopyPersister;
  snapshot: { hash: string; ext: string };
}): AssistantImageAcquisition {
  const { port, resolution, loadSnapshotCache, persistSnapshotCopy } = input;
  const snapshotCacheKey = createAssistantImageSnapshotCacheKey({
    serverId: input.serverId,
    ...input.snapshot,
  });
  const fileName = `${input.snapshot.hash}.${input.snapshot.ext}`;
  const attachmentId = (mimeType: string) =>
    createPreviewAttachmentId({
      mimeType,
      path: fileName,
      contentKey: `assistant-image-snapshot:${input.serverId ?? "unknown-server"}`,
    });
  return {
    key: withGeneration(`snapshot:${snapshotCacheKey}`, input.generation),
    snapshotCacheKey,
    locate: async () => {
      const snapshotCache = (await loadSnapshotCache?.().catch(() => null)) ?? null;
      if (snapshotCache && persistSnapshotCopy) {
        const cached = await snapshotCache.get(snapshotCacheKey).catch(() => null);
        if (cached) {
          try {
            return await persistSnapshotCopy({
              id: attachmentId(cached.mimeType),
              copy: cached.copy,
              mimeType: cached.mimeType,
              fileName,
            });
          } catch {
            await snapshotCache.forget(snapshotCacheKey).catch(() => undefined);
          }
        }
      }
      if (!port) {
        throw new Error(input.unavailableMessage);
      }
      const file = await port.readFile(resolution.cwd, resolution.path);
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      const attachment = await port.persist({
        id: attachmentId(file.mime),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName,
      });
      await snapshotCache
        ?.put(snapshotCacheKey, { bytes: file.bytes, mimeType: file.mime })
        .catch(() => undefined);
      return attachment;
    },
  };
}
