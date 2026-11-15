import { describe, expect, test } from "vitest";
import {
  assertImageSourceBudget,
  estimateDataUrlBytes,
  exceedsImageSourceBudget,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SOURCE_BYTES,
  readImageDimensions,
} from "./image-budget";

function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const be32 = (value: number) => [...be16(Math.floor(value / 65_536)), ...be16(value & 0xffff)];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16(Math.floor(value / 65_536))];
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

describe("readImageDimensions", () => {
  test("reads PNG, GIF, BMP and WebP headers", () => {
    expect(
      readImageDimensions(
        bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(8160), be32(6120)),
      ),
    ).toEqual({ width: 8160, height: 6120 });
    expect(readImageDimensions(bytes("GIF89a", le16(640), le16(480), [0, 0]))).toEqual({
      width: 640,
      height: 480,
    });
    expect(
      readImageDimensions(bytes("BM", Array(12).fill(0), le32(40), le32(300), le32(-200 >>> 0))),
    ).toEqual({ width: 300, height: 200 });
    expect(
      readImageDimensions(
        bytes("RIFF", le32(0), "WEBPVP8X", le32(10), [0, 0, 0, 0], le24(3999), le24(2999)),
      ),
    ).toEqual({ width: 4000, height: 3000 });
    expect(
      readImageDimensions(
        bytes(
          "RIFF",
          le32(0),
          "WEBPVP8 ",
          le32(0),
          [0, 0, 0, 0x9d, 0x01, 0x2a],
          le16(1024),
          le16(768),
        ),
      ),
    ).toEqual({ width: 1024, height: 768 });
  });

  test("walks JPEG segments past a large EXIF block to the frame header", () => {
    const exif = Array(40_000).fill(0x41);
    expect(
      readImageDimensions(
        bytes(
          [0xff, 0xd8, 0xff, 0xe1],
          be16(exif.length + 2),
          exif,
          [0xff, 0xc2],
          be16(17),
          [8],
          be16(6120),
          be16(8160),
          [3],
        ),
      ),
    ).toEqual({ width: 8160, height: 6120 });
  });

  test("reads TIFF in both byte orders", () => {
    const entry = (tag: number, type: number, value: number, order: "II" | "MM") =>
      order === "II"
        ? [
            ...le16(tag),
            ...le16(type),
            ...le32(1),
            ...(type === 3 ? [...le16(value), 0, 0] : le32(value)),
          ]
        : [
            ...be16(tag),
            ...be16(type),
            ...be32(1),
            ...(type === 3 ? [...be16(value), 0, 0] : be32(value)),
          ];
    expect(
      readImageDimensions(
        bytes("II*\0", le32(8), le16(2), entry(256, 4, 12000, "II"), entry(257, 3, 9000, "II")),
      ),
    ).toEqual({ width: 12000, height: 9000 });
    expect(
      readImageDimensions(
        bytes("MM\0*", be32(8), be16(2), entry(256, 3, 640, "MM"), entry(257, 3, 480, "MM")),
      ),
    ).toEqual({ width: 640, height: 480 });
  });

  test("takes the largest ispe box of a gridded HEIC as its decoded size", () => {
    const ispe = (width: number, height: number) => [
      ...be32(20),
      ..."ispe".split("").map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
      ...be32(width),
      ...be32(height),
    ];
    expect(
      readImageDimensions(
        bytes(
          be32(24),
          "ftypheic",
          Array(12).fill(0),
          ispe(512, 512),
          ispe(4032, 3024),
          ispe(512, 512),
        ),
      ),
    ).toEqual({ width: 4032, height: 3024 });
  });

  test("returns null for unknown or truncated data", () => {
    expect(readImageDimensions(bytes("hello world, not an image"))).toBeNull();
    expect(
      readImageDimensions(bytes([0xff, 0xd8, 0xff, 0xe1], be16(5000), Array(20).fill(0))),
    ).toBeNull();
  });
});

describe("image resource budget", () => {
  test("rejects oversized source bytes before decode", () => {
    expect(() =>
      assertImageSourceBudget({ byteSize: MAX_IMAGE_SOURCE_BYTES + 1, label: "huge.png" }),
    ).toThrow("safety limit");
    expect(() =>
      assertImageSourceBudget({ byteSize: MAX_IMAGE_SOURCE_BYTES, label: "safe.png" }),
    ).not.toThrow();
  });

  test("rejects decoded pixel bombs independently of compressed bytes", () => {
    expect(() =>
      assertImageSourceBudget({ byteSize: 1024, width: MAX_IMAGE_PIXELS + 1, height: 1 }),
    ).toThrow("decoded-pixel safety limit");
  });

  test("admits 50MP phone photos and flags 200MP ones for the file path", () => {
    expect(exceedsImageSourceBudget({ byteSize: 18_000_000, width: 8160, height: 6120 })).toBe(
      false,
    );
    expect(exceedsImageSourceBudget({ byteSize: 30_000_000, width: 16320, height: 12240 })).toBe(
      true,
    );
  });

  test("estimates base64 data URL bytes without decoding it", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,aGVsbG8=")).toBe(5);
  });
});
