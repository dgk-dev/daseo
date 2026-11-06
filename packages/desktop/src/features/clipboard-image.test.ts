import { describe, expect, it } from "vitest";
import { readClipboardImageDataUrl } from "./clipboard-image.js";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function clipboardWith(items: Array<{ types: string[]; getType: (type: string) => unknown }>) {
  return {
    read: async () =>
      items.map((item) => ({
        types: item.types,
        getType: async (type: string) => item.getType(type),
      })),
  };
}

describe("readClipboardImageDataUrl", () => {
  it("returns the clipboard image as a PNG data URL", async () => {
    const dataUrl = await readClipboardImageDataUrl(
      clipboardWith([
        { types: ["text/plain"], getType: () => new Blob(["caption"]) },
        {
          types: ["image/png"],
          getType: (type) => new Blob([PNG_SIGNATURE], { type }),
        },
      ]),
    );
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG_SIGNATURE).toString("base64")}`);
  });

  it("returns null when the clipboard holds no image", async () => {
    await expect(
      readClipboardImageDataUrl(
        clipboardWith([{ types: ["text/plain"], getType: () => new Blob(["only text"]) }]),
      ),
    ).resolves.toBeNull();
  });

  it("returns null for an empty image payload", async () => {
    await expect(
      readClipboardImageDataUrl(
        clipboardWith([{ types: ["image/png"], getType: () => new Blob([]) }]),
      ),
    ).resolves.toBeNull();
  });
});
