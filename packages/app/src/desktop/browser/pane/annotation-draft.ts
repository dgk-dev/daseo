import type { AttachmentMetadata, BrowserElementAttachment } from "@/attachments/types";

export interface BrowserElementSelection extends Omit<
  BrowserElementAttachment,
  "formatted" | "comment"
> {
  attributes?: Record<string, string>;
}

export interface BrowserElementAnnotationDraft {
  generation: number;
  selection: BrowserElementSelection;
  captureStatus: "capturing" | "ready";
  screenshot?: AttachmentMetadata;
}

export function beginBrowserElementAnnotation(input: {
  generation: number;
  selection: BrowserElementSelection;
}): BrowserElementAnnotationDraft {
  return {
    generation: input.generation,
    selection: input.selection,
    captureStatus: "capturing",
  };
}

export function settleBrowserElementAnnotationCapture(
  draft: BrowserElementAnnotationDraft | null,
  input: { generation: number; screenshot?: AttachmentMetadata },
): BrowserElementAnnotationDraft | null {
  if (!draft || draft.generation !== input.generation) {
    return draft;
  }
  if (input.screenshot) {
    return { ...draft, captureStatus: "ready", screenshot: input.screenshot };
  }
  return { ...draft, captureStatus: "ready" };
}
