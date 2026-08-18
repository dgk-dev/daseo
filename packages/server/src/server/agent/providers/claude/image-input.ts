import { materializeProviderImage } from "../provider-image-output.js";

export type ClaudeSupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type ClaudeUserImageContent =
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: ClaudeSupportedImageMimeType;
        data: string;
      };
    }
  | { type: "text"; text: string };

export function isClaudeSupportedImageMimeType(
  value: string,
): value is ClaudeSupportedImageMimeType {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

export function mapClaudeUserImageContent(
  image: { data: string; mimeType: string },
  materialize: typeof materializeProviderImage = materializeProviderImage,
): ClaudeUserImageContent {
  if (isClaudeSupportedImageMimeType(image.mimeType)) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
      },
    };
  }

  try {
    const local = materialize(image);
    return {
      type: "text",
      text: `[User attached an image in ${image.mimeType}, which cannot be embedded directly. Inspect the original image at: ${local.path}]`,
    };
  } catch (error) {
    return {
      type: "text",
      text: `[User image attachment could not be embedded or materialized: ${error instanceof Error ? error.message : String(error)}]`,
    };
  }
}
