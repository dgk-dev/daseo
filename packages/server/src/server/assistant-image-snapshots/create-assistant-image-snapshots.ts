import path from "node:path";

import type { Logger } from "pino";

import { registerReadableRoot } from "../file-explorer/service.js";
import { AssistantImageSnapshotStore } from "./assistant-image-snapshot-store.js";
import { AssistantImageSnapshotter } from "./assistant-image-snapshotter.js";

/**
 * Daseo: opens the assistant image snapshot store under `$PASEO_HOME/assistant-images`,
 * removes blobs a stopped daemon left without a reference, and lets clients read the blobs
 * through the file reader even when `$PASEO_HOME` lies outside home and temp.
 */
export function createAssistantImageSnapshots(input: {
  paseoHome: string;
  logger: Logger;
}): AssistantImageSnapshotter {
  const store = new AssistantImageSnapshotStore({
    rootDir: path.join(input.paseoHome, "assistant-images"),
  });
  registerReadableRoot(store.blobDir);
  try {
    const removed = store.sweepUnreferencedBlobs();
    if (removed > 0) {
      input.logger.info({ removed }, "assistant_image_snapshots.swept_unreferenced");
    }
  } catch (error) {
    input.logger.warn({ err: error }, "assistant_image_snapshots.sweep_failed");
  }
  return new AssistantImageSnapshotter(store);
}
