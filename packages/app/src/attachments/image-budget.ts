import { i18n } from "@/i18n/i18next";

export const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
// 52M covers 50MP phone photos (8160x6120 = 49.9M); 200MP shots stay out and go through
// the file-upload path instead (delta 45).
export const MAX_IMAGE_PIXELS = 52_000_000;
export const IMAGE_REENCODE_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const IMAGE_REENCODE_MAX_DIMENSION = 4_096;

/** Name used in image messages when the file has none. */
export function imageFallbackLabel(): string {
  return i18n.t("attachments.imageErrors.fallbackLabel", { defaultValue: "Image" });
}

export function exceedsImageSourceBudget(input: {
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
}): boolean {
  try {
    assertImageSourceBudget(input);
    return false;
  } catch {
    return true;
  }
}

export function assertImageSourceBudget(input: {
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
  label?: string | null;
}): void {
  const label = input.label?.trim() || imageFallbackLabel();
  if (input.byteSize != null && input.byteSize > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error(
      i18n.t("attachments.imageErrors.tooManyBytes", {
        defaultValue: "{{label}} is {{size}} MB; the safety limit is {{limit}} MB.",
        label,
        size: (input.byteSize / (1024 * 1024)).toFixed(1),
        limit: MAX_IMAGE_SOURCE_BYTES / (1024 * 1024),
      }),
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
      i18n.t("attachments.imageErrors.tooManyPixels", {
        defaultValue:
          "{{label}} is {{width}}×{{height}}; the decoded-pixel safety limit is {{limit}} pixels.",
        label,
        width: input.width,
        height: input.height,
        limit: MAX_IMAGE_PIXELS.toLocaleString(),
      }),
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

// Enough for the header of every format below, including JPEGs whose SOF marker follows large
// EXIF/maker-note segments and HEIF files whose `meta` box precedes the image data.
export const IMAGE_HEADER_PROBE_BYTES = 512 * 1024;

export interface ImageDimensions {
  width: number;
  height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + u16be(bytes, offset + 1) * 256 + bytes[offset + 3]!;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + u16le(bytes, offset + 2) * 65_536;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}

function dimensions(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return dimensions(u32be(bytes, 16), u32be(bytes, 20));
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return dimensions(u16be(bytes, offset + 7), u16be(bytes, offset + 5));
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    offset += 2 + u16be(bytes, offset + 2);
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return dimensions(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    return dimensions(
      1 + (((b1 & 0x3f) << 8) | b0),
      1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    );
  }
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return dimensions(width, height);
  }
  return null;
}

function bmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) return null;
  const headerSize = u32le(bytes, 14);
  if (headerSize === 12) return dimensions(u16le(bytes, 18), u16le(bytes, 20));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dimensions(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

function tiffDimensions(bytes: Uint8Array): ImageDimensions | null {
  const littleEndian = bytes[0] === 0x49;
  const read16 = (offset: number) => (littleEndian ? u16le(bytes, offset) : u16be(bytes, offset));
  const read32 = (offset: number) => (littleEndian ? u32le(bytes, offset) : u32be(bytes, offset));
  const ifd = read32(4);
  if (ifd + 2 > bytes.length) return null;
  const entries = read16(ifd);
  let width = 0;
  let height = 0;
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    const tag = read16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const type = read16(entry + 2);
    const value = type === 3 ? read16(entry + 8) : read32(entry + 8);
    if (tag === 256) width = value;
    else height = value;
  }
  return dimensions(width, height);
}

// HEIF/AVIF keep each image item's size in an `ispe` property box. A gridded photo carries one
// for the full image and one per tile; the largest is the decoded size.
function isobmffDimensions(bytes: Uint8Array): ImageDimensions | null {
  let best: ImageDimensions | null = null;
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (
      bytes[offset] !== 0x69 ||
      bytes[offset + 1] !== 0x73 ||
      bytes[offset + 2] !== 0x70 ||
      bytes[offset + 3] !== 0x65
    ) {
      continue;
    }
    const found = dimensions(u32be(bytes, offset + 8), u32be(bytes, offset + 12));
    if (found && (!best || found.width * found.height > best.width * best.height)) best = found;
  }
  return best;
}

/**
 * Reads an image's pixel size from its first bytes without decoding it. Returns null for an
 * unknown format or a header that does not fit in `bytes`.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return pngDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  if (ascii(bytes, 0, 4) === "GIF8") return dimensions(u16le(bytes, 6), u16le(bytes, 8));
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpDimensions(bytes);
  if (ascii(bytes, 0, 2) === "BM") return bmpDimensions(bytes);
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*")
    return tiffDimensions(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") return isobmffDimensions(bytes);
  return null;
}
