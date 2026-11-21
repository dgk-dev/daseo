import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { fromWireDraft, toWireDraft, wireDraftKey } from "./wire";

// Daseo delta 139: the synced draft on the wire and back.
const uploadedImage: UserComposerAttachment = {
  kind: "image",
  metadata: {
    id: "img1",
    mimeType: "image/heic",
    storageType: "native-file",
    storageKey: "/cache/img1.heic",
    fileName: "IMG_0001.HEIC",
    byteSize: 2048,
    createdAt: 5,
    hostUpload: {
      uploadId: "upload_x",
      mimeType: "image/jpeg",
      thumbnail: { mimeType: "image/jpeg", width: 256, height: 192 },
    },
  },
};
const pendingImage: UserComposerAttachment = {
  kind: "image",
  metadata: {
    id: "img2",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "img2",
    createdAt: 6,
  },
};
const file: UserComposerAttachment = {
  kind: "file",
  attachment: {
    type: "uploaded_file",
    id: "upload_doc",
    fileName: "spec.pdf",
    mimeType: "application/pdf",
    size: 99,
    path: "/Users/me/.paseo/uploads/upload_doc/spec.pdf",
  },
};
const workspaceFile: UserComposerAttachment = {
  kind: "workspace_file",
  path: "src/a.ts",
  selection: { kind: "line_range", startLine: 1, endLine: 4 },
};

describe("composer draft wire mapping", () => {
  it("sends uploaded images and files with their upload id and leaves pending images local", () => {
    const wire = toWireDraft({
      text: "hi",
      attachments: [uploadedImage, pendingImage, file, workspaceFile],
    });
    expect(wire.attachments.map((a) => [a.kind, a.uploadId ?? null])).toEqual([
      ["image", "upload_x"],
      ["file", "upload_doc"],
      ["workspace_file", null],
    ]);
    expect(wire.attachments[0]).toMatchObject({
      mimeType: "image/jpeg",
      fileName: "IMG_0001.HEIC",
    });
  });

  it("shows another device's image as a host upload with its thumbnail", () => {
    const wire = toWireDraft({ text: "hi", attachments: [uploadedImage, file, workspaceFile] });
    const draft = fromWireDraft(wire, undefined, "srv");
    expect(draft.attachments[0]).toEqual({
      kind: "image",
      metadata: {
        id: "img1",
        mimeType: "image/jpeg",
        storageType: "host-upload",
        storageKey: "upload_x",
        fileName: "IMG_0001.HEIC",
        byteSize: 2048,
        createdAt: 0,
        hostUpload: {
          uploadId: "upload_x",
          mimeType: "image/jpeg",
          thumbnail: { mimeType: "image/jpeg", width: 256, height: 192 },
          serverId: "srv",
        },
      },
    });
    expect(draft.attachments.slice(1)).toEqual([file, workspaceFile]);
    // Applying and sending back gives the same synced content (no echo loop).
    expect(wireDraftKey(toWireDraft(draft))).toBe(wireDraftKey(wire));
  });

  it("keeps the attaching device's own copy and its images still uploading", () => {
    const wire = toWireDraft({ text: "x", attachments: [uploadedImage] });
    const draft = fromWireDraft(
      wire,
      { text: "", attachments: [uploadedImage, pendingImage] },
      "srv",
    );
    expect(draft.attachments).toEqual([uploadedImage, pendingImage]);
  });

  it("drops attachments of a kind this app cannot read", () => {
    const draft = fromWireDraft(
      { text: "", attachments: [{ id: "x", kind: "future_kind", data: '{"kind":"future_kind"}' }] },
      undefined,
      "srv",
    );
    expect(draft.attachments).toEqual([]);
  });
});
