import { describe, expect, it } from "vitest";
import { readClipboardImageDataUrl } from "./clipboard-image.js";

describe("readClipboardImageDataUrl", () => {
  it("returns Electron's canonical PNG for a clipboard image", () => {
    expect(
      readClipboardImageDataUrl({
        readImage: () => ({
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
        }),
      }),
    ).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("returns null for an empty clipboard image", () => {
    expect(
      readClipboardImageDataUrl({
        readImage: () => ({
          isEmpty: () => true,
          toDataURL: () => {
            throw new Error("must not encode an empty image");
          },
        }),
      }),
    ).toBeNull();
  });

  it("rejects malformed native-image output", () => {
    expect(
      readClipboardImageDataUrl({
        readImage: () => ({
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,",
        }),
      }),
    ).toBeNull();
  });
});
