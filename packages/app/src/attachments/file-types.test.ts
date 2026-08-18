import { describe, expect, it } from "vitest";
import {
  getMimeTypeFromPath,
  getRasterImageMimeTypeFromPath,
  isRasterImageFile,
  isRasterImageMimeType,
  isRasterImagePath,
  isAgentImageMimeType,
  AGENT_IMAGE_FILE_EXTENSIONS,
  RASTER_IMAGE_FILE_EXTENSIONS,
  resolveRasterImageMimeType,
} from "./file-types";

describe("attachment file types", () => {
  it("keeps SVG as a file while treating raster image files as images", () => {
    expect(getMimeTypeFromPath("/tmp/logo.svg")).toBe("application/octet-stream");
    expect(isRasterImagePath("/tmp/logo.svg")).toBe(false);
    expect(isRasterImageMimeType("image/svg+xml")).toBe(false);
    expect(isRasterImageFile(new File(["<svg />"], "logo.svg", { type: "image/svg+xml" }))).toBe(
      false,
    );

    expect(getRasterImageMimeTypeFromPath("/tmp/screenshot.PNG?cache=1")).toBe("image/png");
    expect(getMimeTypeFromPath("/tmp/screenshot.PNG?cache=1")).toBe("image/png");
    expect(isRasterImagePath("/tmp/screenshot.PNG?cache=1")).toBe(true);
    expect(isRasterImageMimeType("image/png; charset=binary")).toBe(true);
    expect(isRasterImageFile(new File([new Uint8Array([0])], "screenshot.png"))).toBe(true);
  });

  it("does not require MIME table entries for generic file attachments", () => {
    expect(getMimeTypeFromPath("/tmp/notes.md")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/archive.zip")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/report.docx")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/runtime.log")).toBe("application/octet-stream");
    expect(getMimeTypeFromPath("/tmp/export.anything")).toBe("application/octet-stream");
  });

  it("keeps broad raster detection but only offers provider-compatible picker formats", () => {
    expect(new Set(RASTER_IMAGE_FILE_EXTENSIONS)).toEqual(
      new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"]),
    );
    expect(AGENT_IMAGE_FILE_EXTENSIONS).toEqual(["png", "jpg", "jpeg", "gif", "webp"]);
    expect(isAgentImageMimeType("image/png")).toBe(true);
    expect(isAgentImageMimeType("image/jpg")).toBe(true);
    expect(isAgentImageMimeType("image/heic")).toBe(false);
    expect(isAgentImageMimeType("image/tiff")).toBe(false);
  });

  it("uses explicit raster MIME metadata before the filename", () => {
    expect(
      resolveRasterImageMimeType({ mimeType: "image/jpeg", path: "/tmp/screenshot.png" }),
    ).toBe("image/jpeg");
    expect(
      resolveRasterImageMimeType({
        mimeType: "image/png; charset=binary",
        path: "/tmp/screenshot.jpg",
      }),
    ).toBe("image/png");
  });

  it("uses the filename only when MIME metadata is absent", () => {
    expect(resolveRasterImageMimeType({ mimeType: "", path: "/tmp/screenshot.png" })).toBe(
      "image/png",
    );
    expect(
      resolveRasterImageMimeType({
        mimeType: "application/octet-stream",
        path: "/tmp/screenshot.png",
      }),
    ).toBeNull();
  });
});
