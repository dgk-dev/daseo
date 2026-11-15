import { describe, expect, it } from "vitest";
import { normalizePickedImageAssets } from "./picked-image-normalizer";

describe("native image attachment picker", () => {
  it("preserves native picked JPEG and PNG attachment inputs", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///photos/IMG_0001.JPG",
        mimeType: "image/jpeg",
        fileName: "picked.jpeg",
      },
      {
        uri: "file:///photos/screenshot.png",
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/IMG_0001.JPG" },
        mimeType: "image/jpeg",
        fileName: "picked.jpg",
      },
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.png" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
  });

  it("uses explicit native MIME metadata before the URI extension", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///photos/screenshot.jpg",
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.jpg" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
  });

  it("labels a HEIC file by its content without decoding it, for conversion when attached", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///photos/IMG_0001.HEIC",
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/IMG_0001.HEIC" },
        mimeType: "image/heic",
        fileName: "picked.png",
      },
    ]);
  });

  it("keeps GIF and WebP as picked so an animation survives", async () => {
    const result = await normalizePickedImageAssets([
      { uri: "file:///photos/loop.gif", mimeType: "image/gif", fileName: "loop.gif" },
      { uri: "file:///photos/sticker.webp", mimeType: "image/webp", fileName: "sticker.webp" },
    ]);

    expect(result.map((entry) => entry.mimeType)).toEqual(["image/gif", "image/webp"]);
    expect(result.map((entry) => entry.source)).toEqual([
      { kind: "file_uri", uri: "file:///photos/loop.gif" },
      { kind: "file_uri", uri: "file:///photos/sticker.webp" },
    ]);
  });

  it("refuses a gallery photo over the pixel budget before anything decodes it", async () => {
    await expect(
      normalizePickedImageAssets([
        {
          uri: "file:///photos/huge.jpg",
          mimeType: "image/jpeg",
          fileName: "huge.jpg",
          width: 16_384,
          height: 12_288,
        },
      ]),
    ).rejects.toThrow("decoded-pixel safety limit");
  });

  it("refuses content that is not a raster image", async () => {
    await expect(
      normalizePickedImageAssets([
        { uri: "file:///photos/doc.pdf", mimeType: "application/pdf", fileName: "doc.pdf" },
      ]),
    ).rejects.toThrow("Unsupported image type");
  });
});
