import type { AttachmentMetadata } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { assertImageSourceBudget, estimateDataUrlBytes } from "@/attachments/image-budget";
import { generateAttachmentId } from "@/attachments/utils";
import type { BrowserElementSelection } from "./annotation-draft";

export type AnnotationCaptureFailure =
  | { reason: "unavailable" }
  | { reason: "empty_selection" }
  | { reason: "too_large"; detail: string }
  | { reason: "failed" };

export type AnnotationCaptureResult =
  | { status: "captured"; screenshot: AttachmentMetadata; release: () => void }
  | { status: "failed"; failure: AnnotationCaptureFailure };

type CaptureElement = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => Promise<string | null | undefined>;

/**
 * Captures and persists an element screenshot for the annotation editor. The file is retained
 * for attachment garbage collection before it is written, so a collection that runs while the
 * editor is open (any draft save triggers one) cannot delete it. The caller owns `release` and
 * calls it once the screenshot is cancelled, replaced, or handed to the workspace attachment
 * store, which retains it from then on.
 */
export async function captureAnnotationScreenshot(input: {
  captureElement: CaptureElement | undefined;
  selection: BrowserElementSelection;
  persist: (input: {
    id: string;
    dataUrl: string;
    mimeType: string;
    fileName: string;
  }) => Promise<AttachmentMetadata>;
  createId?: () => string;
}): Promise<AnnotationCaptureResult> {
  if (typeof input.captureElement !== "function") {
    return { status: "failed", failure: { reason: "unavailable" } };
  }
  const { x, y, width, height } = input.selection.boundingRect;
  if (width <= 0 || height <= 0) {
    return { status: "failed", failure: { reason: "empty_selection" } };
  }
  let dataUrl: string | null | undefined;
  try {
    dataUrl = await input.captureElement({ x, y, width, height });
  } catch (error) {
    console.warn("[browser-pane] captureElement failed", error);
    return { status: "failed", failure: { reason: "failed" } };
  }
  if (!dataUrl) {
    return { status: "failed", failure: { reason: "failed" } };
  }
  const fileName = `element-${input.selection.tag}.png`;
  try {
    assertImageSourceBudget({ byteSize: estimateDataUrlBytes(dataUrl), label: fileName });
  } catch (error) {
    return {
      status: "failed",
      failure: { reason: "too_large", detail: error instanceof Error ? error.message : "" },
    };
  }
  const id = (input.createId ?? generateAttachmentId)();
  const release = retainAttachmentForGarbageCollection(id);
  try {
    const screenshot = await input.persist({ id, dataUrl, mimeType: "image/png", fileName });
    return { status: "captured", screenshot, release };
  } catch (error) {
    release();
    console.warn("[browser-pane] persisting element screenshot failed", error);
    return { status: "failed", failure: { reason: "failed" } };
  }
}

/** Holds the retention of the screenshot that the open annotation editor shows, if any. */
export function createAnnotationScreenshotHold() {
  let heldRelease: (() => void) | null = null;
  return {
    hold(release: () => void): void {
      heldRelease?.();
      heldRelease = release;
    },
    release(): void {
      const release = heldRelease;
      heldRelease = null;
      release?.();
    },
  };
}
