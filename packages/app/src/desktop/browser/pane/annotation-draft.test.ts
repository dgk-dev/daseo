import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  beginBrowserElementAnnotation,
  settleBrowserElementAnnotationCapture,
  type BrowserElementSelection,
} from "./annotation-draft";

const firstSelection = selection("#first");
const secondSelection = selection("#second");
const firstScreenshot = screenshot("screenshot-first");
const secondScreenshot = screenshot("screenshot-second");

describe("browser element annotation draft", () => {
  it("keeps submit pending until the current selection capture settles", () => {
    const capturing = beginBrowserElementAnnotation({
      generation: 1,
      selection: firstSelection,
    });

    expect(capturing.captureStatus).toBe("capturing");

    const ready = settleBrowserElementAnnotationCapture(capturing, {
      generation: 1,
      screenshot: firstScreenshot,
    });

    expect(ready).toEqual({
      generation: 1,
      selection: firstSelection,
      captureStatus: "ready",
      screenshot: firstScreenshot,
    });
  });

  it("ignores a late capture from an earlier selection", () => {
    const current = beginBrowserElementAnnotation({
      generation: 2,
      selection: secondSelection,
    });

    expect(
      settleBrowserElementAnnotationCapture(current, {
        generation: 1,
        screenshot: firstScreenshot,
      }),
    ).toBe(current);

    expect(
      settleBrowserElementAnnotationCapture(current, {
        generation: 2,
        screenshot: secondScreenshot,
      }),
    ).toEqual({
      generation: 2,
      selection: secondSelection,
      captureStatus: "ready",
      screenshot: secondScreenshot,
    });
  });

  it("marks a failed capture ready without attaching an image", () => {
    const current = beginBrowserElementAnnotation({
      generation: 1,
      selection: firstSelection,
    });

    expect(settleBrowserElementAnnotationCapture(current, { generation: 1 })).toEqual({
      generation: 1,
      selection: firstSelection,
      captureStatus: "ready",
    });
  });
});

function selection(selector: string): BrowserElementSelection {
  return {
    url: "https://example.com",
    selector,
    tag: "button",
    text: selector,
    outerHTML: `<button id="${selector.slice(1)}">${selector}</button>`,
    computedStyles: {},
    boundingRect: { x: 0, y: 0, width: 100, height: 40 },
    reactSource: null,
    parentChain: [],
    children: [],
  };
}

function screenshot(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "desktop-file",
    storageKey: `/tmp/${id}.png`,
    createdAt: 1,
  };
}
