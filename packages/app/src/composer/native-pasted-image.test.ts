import { describe, expect, it } from "vitest";
import { normalizeNativePastedImages, UnsupportedPastedImageError } from "./native-pasted-image";

describe("normalizeNativePastedImages", () => {
  it("turns pasted native image files into the existing picked-image input", async () => {
    await expect(
      normalizeNativePastedImages([
        {
          fileName: "clipboard.jpg",
          fileSize: 128,
          type: "image/jpg",
          uri: "file:///cache/clipboard.jpg",
        },
        {
          fileName: "animation.gif",
          fileSize: 256,
          type: "image/gif",
          uri: "file:///cache/animation.gif",
        },
      ]),
    ).resolves.toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/clipboard.jpg" },
        mimeType: "image/jpeg",
        fileName: "clipboard.jpg",
      },
      {
        source: { kind: "file_uri", uri: "file:///cache/animation.gif" },
        mimeType: "image/gif",
        fileName: "animation.gif",
      },
    ]);
  });

  it("rejects non-image content instead of swallowing it as an attachment", async () => {
    await expect(
      normalizeNativePastedImages([
        {
          fileName: "notes.txt",
          fileSize: 12,
          type: "text/plain",
          uri: "file:///cache/notes.txt",
        },
      ]),
    ).rejects.toThrow(UnsupportedPastedImageError);
  });
});
