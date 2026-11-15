import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import {
  encodeAttachmentsForSend,
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
} from "@/attachments/service";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { captureAnnotationScreenshot, createAnnotationScreenshotHold } from "./annotation-capture";
import type { BrowserElementSelection } from "./annotation-draft";

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

/** A managed-file store whose garbage collection deletes every file not referenced. */
function createFileStore(): AttachmentStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    storageType: "desktop-file",
    files,
    async save(input) {
      const id = input.id ?? "generated";
      files.set(id, "aGVsbG8=");
      const metadata: AttachmentMetadata = {
        id,
        mimeType: input.mimeType ?? "image/png",
        storageType: "desktop-file",
        storageKey: `/paseo/desktop-attachments/${id}.png`,
        fileName: input.fileName,
        byteSize: 5,
        createdAt: 1,
      };
      return metadata;
    },
    async encodeBase64({ attachment }) {
      const data = files.get(attachment.id);
      if (!data) {
        throw Object.assign(new Error(`ENOENT: no such file or directory`), { code: "ENOENT" });
      }
      return data;
    },
    async resolvePreviewUrl({ attachment }) {
      return `file://${attachment.storageKey}`;
    },
    async delete({ attachment }) {
      files.delete(attachment.id);
    },
    async garbageCollect({ referencedIds }) {
      for (const id of Array.from(files.keys())) {
        if (!referencedIds.has(id)) files.delete(id);
      }
    },
  };
}

function selection(width = 120, height = 40): BrowserElementSelection {
  return {
    url: "https://example.com",
    selector: "#target",
    tag: "div",
    text: "target",
    outerHTML: '<div id="target">target</div>',
    computedStyles: {},
    boundingRect: { x: 0, y: 0, width, height },
    reactSource: null,
    parentChain: [],
    children: [],
  };
}

const persist = (input: { id: string; dataUrl: string; mimeType: string; fileName: string }) =>
  persistAttachmentFromDataUrl(input);

describe("annotation screenshot capture", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey: "scope" });
  });

  it("keeps the screenshot through a garbage collection while the editor is open, then sends it", async () => {
    const store = createFileStore();
    __setAttachmentStoreForTests(store);
    const hold = createAnnotationScreenshotHold();

    const result = await captureAnnotationScreenshot({
      captureElement: async () => PNG_DATA_URL,
      selection: selection(),
      persist,
    });
    if (result.status !== "captured") throw new Error("expected a capture");
    hold.hold(result.release);

    // The user is still typing the note; any draft save runs a collection.
    await garbageCollectAttachments({ referencedIds: new Set() });
    expect(store.files.has(result.screenshot.id)).toBe(true);

    // Submit: ownership passes to the workspace attachment store.
    useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
      scopeKey: "scope",
      attachment: {
        kind: "browser_element",
        attachment: {
          url: "https://example.com",
          selector: "#target",
          tag: "div",
          text: "target",
          outerHTML: "",
          computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 120, height: 40 },
          reactSource: null,
          parentChain: [],
          children: [],
          formatted: "div",
          screenshot: result.screenshot,
        },
      },
    });
    hold.release();
    await garbageCollectAttachments({ referencedIds: new Set() });

    await expect(encodeAttachmentsForSend([result.screenshot])).resolves.toEqual([
      { data: "aGVsbG8=", mimeType: "image/png" },
    ]);
  });

  it("lets a cancelled capture be collected", async () => {
    const store = createFileStore();
    __setAttachmentStoreForTests(store);
    const hold = createAnnotationScreenshotHold();

    const result = await captureAnnotationScreenshot({
      captureElement: async () => PNG_DATA_URL,
      selection: selection(),
      persist,
    });
    if (result.status !== "captured") throw new Error("expected a capture");
    hold.hold(result.release);
    hold.release();
    await garbageCollectAttachments({ referencedIds: new Set() });

    expect(store.files.has(result.screenshot.id)).toBe(false);
  });

  it("reports why no screenshot was captured", async () => {
    __setAttachmentStoreForTests(createFileStore());
    await expect(
      captureAnnotationScreenshot({ captureElement: undefined, selection: selection(), persist }),
    ).resolves.toEqual({ status: "failed", failure: { reason: "unavailable" } });
    await expect(
      captureAnnotationScreenshot({
        captureElement: async () => PNG_DATA_URL,
        selection: selection(0, 40),
        persist,
      }),
    ).resolves.toEqual({ status: "failed", failure: { reason: "empty_selection" } });
    await expect(
      captureAnnotationScreenshot({
        captureElement: async () => {
          throw new Error("webview gone");
        },
        selection: selection(),
        persist,
      }),
    ).resolves.toEqual({ status: "failed", failure: { reason: "failed" } });
    const huge = `data:image/png;base64,${"A".repeat(44 * 1024 * 1024)}`;
    const tooLarge = await captureAnnotationScreenshot({
      captureElement: async () => huge,
      selection: selection(),
      persist,
    });
    expect(tooLarge).toMatchObject({ status: "failed", failure: { reason: "too_large" } });
  });
});
