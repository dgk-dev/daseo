import type { ComposerAttachment } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";

/** Keeps the managed image files of these attachments out of attachment garbage collection. */
export function retainComposerAttachmentFiles(
  attachments: readonly ComposerAttachment[],
): () => void {
  const releases: Array<() => void> = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      releases.push(retainAttachmentForGarbageCollection(attachment.metadata.id));
    } else if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
      releases.push(retainAttachmentForGarbageCollection(attachment.attachment.screenshot.id));
    }
  }
  return () => {
    for (const release of releases) release();
  };
}
