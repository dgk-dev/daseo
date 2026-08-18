export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_REENCODE_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const IMAGE_REENCODE_MAX_DIMENSION = 4_096;

export function assertImageSourceBudget(input: {
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
  label?: string | null;
}): void {
  const label = input.label?.trim() || "Image";
  if (input.byteSize != null && input.byteSize > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(
      `${label} is ${(input.byteSize / (1024 * 1024)).toFixed(1)} MB; the safety limit is ${MAX_IMAGE_SOURCE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (
    input.width != null &&
    input.height != null &&
    input.width > 0 &&
    input.height > 0 &&
    input.width * input.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error(
      `${label} is ${input.width}×${input.height}; the decoded-pixel safety limit is ${MAX_IMAGE_PIXELS.toLocaleString()} pixels.`,
    );
  }
}

export function estimateDataUrlBytes(dataUrl: string): number | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const payload = dataUrl.slice(comma + 1).replace(/\s/g, "");
  if (!dataUrl.slice(0, comma).includes(";base64")) {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
  }
  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}
