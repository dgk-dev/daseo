import { createExpoAttachmentFileSystem } from "@/attachments/attachment-file-system";
import {
  createAssistantImageSnapshotCache,
  type AssistantImageSnapshotBytesStore,
  type AssistantImageSnapshotCache,
} from "./snapshot-cache";
import { asyncStorageSnapshotIndex } from "./snapshot-cache-index-storage";

const DIRECTORY_NAME = "paseo-assistant-image-snapshots";

function createNativeSnapshotBytesStore(): AssistantImageSnapshotBytesStore {
  const fileSystem = createExpoAttachmentFileSystem();
  const directory = fileSystem.cacheDirectory
    ? `${fileSystem.cacheDirectory}${DIRECTORY_NAME}/`
    : null;
  function requireDirectory(): string {
    if (!directory) {
      throw new Error("The cache directory is unavailable.");
    }
    return directory;
  }
  return {
    async read(name) {
      const uri = `${requireDirectory()}${name}`;
      const info = await fileSystem.getInfo(uri);
      return info.exists && !info.isDirectory ? { kind: "file_uri", uri } : null;
    },
    async write({ name, bytes }) {
      const target = requireDirectory();
      const info = await fileSystem.getInfo(target);
      if (!info.exists) {
        await fileSystem.makeDirectory(target, { intermediates: true });
      }
      await fileSystem.writeBytes(`${target}${name}`, bytes);
    },
    async delete(name) {
      await fileSystem.delete(`${requireDirectory()}${name}`, { idempotent: true });
    },
  };
}

let cache: AssistantImageSnapshotCache | null = null;

export function getAssistantImageSnapshotCache(): AssistantImageSnapshotCache {
  cache ??= createAssistantImageSnapshotCache({
    bytes: createNativeSnapshotBytesStore(),
    index: asyncStorageSnapshotIndex,
  });
  return cache;
}
