import { describe, expect, it, vi } from "vitest";
import { mapClaudeUserImageContent } from "./image-input.js";

describe("mapClaudeUserImageContent", () => {
  it("embeds Claude-supported images directly", () => {
    const materialize = vi.fn();
    expect(
      mapClaudeUserImageContent({ data: "iVBORw0KGgo=", mimeType: "image/png" }, materialize),
    ).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("gives unsupported images a readable local fallback instead of dropping them", () => {
    expect(
      mapClaudeUserImageContent({ data: "unsupported", mimeType: "image/heic" }, () => ({
        path: "/tmp/paseo-attachments/image.heic",
      })),
    ).toEqual({
      type: "text",
      text: "[User attached an image in image/heic, which cannot be embedded directly. Inspect the original image at: /tmp/paseo-attachments/image.heic]",
    });
  });

  it("surfaces materialization failures in the prompt", () => {
    expect(
      mapClaudeUserImageContent({ data: "broken", mimeType: "image/tiff" }, () => {
        throw new Error("disk full");
      }),
    ).toEqual({
      type: "text",
      text: "[User image attachment could not be embedded or materialized: disk full]",
    });
  });
});
