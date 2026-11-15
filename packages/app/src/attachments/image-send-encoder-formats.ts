import type { AgentImageMimeType } from "@/attachments/file-types";

export type OversizedImageFormat = "png" | "jpeg";

/**
 * Output formats to try, in order, for an image over the send limit. PNG, WebP and GIF can be
 * transparent, so PNG comes first and keeps the alpha; JPEG is the last resort because it is
 * the smallest. A JPEG source has no alpha and goes straight to JPEG.
 */
export function chooseOversizedImageFormats(
  mimeType: AgentImageMimeType,
): readonly OversizedImageFormat[] {
  return mimeType === "image/jpeg" ? ["jpeg"] : ["png", "jpeg"];
}

/**
 * Whether a GIF header announces an animation (the NETSCAPE2.0 or ANIMEXTS1.0 looping
 * extension that every animated GIF encoder writes next to the header).
 */
export function isAnimatedGifHeader(header: Uint8Array): boolean {
  let text = "";
  for (let index = 0; index < Math.min(header.length, 4096); index += 1) {
    text += String.fromCharCode(header[index]!);
  }
  return text.startsWith("GIF8") && (text.includes("NETSCAPE2.0") || text.includes("ANIMEXTS1.0"));
}
