import { describe, expect, it } from "vitest";
import { chooseOversizedImageFormats, isAnimatedGifHeader } from "./image-send-encoder-formats";

function text(value: string): Uint8Array {
  return new Uint8Array([...value].map((char) => char.charCodeAt(0)));
}

describe("oversized image re-encoding", () => {
  it("tries PNG first for formats that can be transparent and JPEG directly for JPEG", () => {
    expect(chooseOversizedImageFormats("image/png")).toEqual(["png", "jpeg"]);
    expect(chooseOversizedImageFormats("image/webp")).toEqual(["png", "jpeg"]);
    expect(chooseOversizedImageFormats("image/gif")).toEqual(["png", "jpeg"]);
    expect(chooseOversizedImageFormats("image/jpeg")).toEqual(["jpeg"]);
  });

  it("recognises an animated GIF by its looping extension", () => {
    expect(isAnimatedGifHeader(text("GIF89a......!\xff\x0bNETSCAPE2.0\x03\x01"))).toBe(true);
    expect(isAnimatedGifHeader(text("GIF89a......,"))).toBe(false);
    expect(isAnimatedGifHeader(text("\x89PNG....NETSCAPE2.0"))).toBe(false);
  });
});
