import { z } from "zod";
import { asUint8Array } from "./terminal.js";

export const BrowserStreamOpcode = {
  Frame: 0x20,
} as const;

export type BrowserStreamOpcode = (typeof BrowserStreamOpcode)[keyof typeof BrowserStreamOpcode];

export const BrowserStreamFrameMetaSchema = z.object({
  /** Monotonic frame sequence per stream; watchers use it to drop stale frames. */
  seq: z.number().int().nonnegative(),
  /** CSS viewport width of the streamed guest, for input coordinate mapping. */
  width: z.number().int().positive(),
  /** CSS viewport height of the streamed guest, for input coordinate mapping. */
  height: z.number().int().positive(),
});

export type BrowserStreamFrameMeta = z.infer<typeof BrowserStreamFrameMetaSchema>;

export interface BrowserStreamFrame {
  opcode: typeof BrowserStreamOpcode.Frame;
  browserId: string;
  meta: BrowserStreamFrameMeta;
  /** JPEG image bytes. */
  payload: Uint8Array;
}

const MAX_BROWSER_ID_BYTES = 255;

function encodeAscii(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      throw new Error("browser stream frame strings must be ASCII");
    }
    out[index] = code;
  }
  return out;
}

function decodeAscii(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
}

export function encodeBrowserStreamFrame(input: {
  browserId: string;
  meta: BrowserStreamFrameMeta;
  payload: Uint8Array | ArrayBuffer | string;
}): Uint8Array {
  const browserIdBytes = encodeAscii(input.browserId);
  if (browserIdBytes.byteLength === 0 || browserIdBytes.byteLength > MAX_BROWSER_ID_BYTES) {
    throw new Error("browser stream frame requires a browserId of 1-255 ASCII bytes");
  }
  const metaBytes = encodeAscii(JSON.stringify(BrowserStreamFrameMetaSchema.parse(input.meta)));
  if (metaBytes.byteLength > 0xffff) {
    throw new Error("browser stream frame metadata too large");
  }
  const payload = asUint8Array(input.payload) ?? new Uint8Array(0);
  const bytes = new Uint8Array(
    1 + 1 + browserIdBytes.byteLength + 2 + metaBytes.byteLength + payload.byteLength,
  );
  let offset = 0;
  bytes[offset] = BrowserStreamOpcode.Frame;
  offset += 1;
  bytes[offset] = browserIdBytes.byteLength;
  offset += 1;
  bytes.set(browserIdBytes, offset);
  offset += browserIdBytes.byteLength;
  bytes[offset] = (metaBytes.byteLength >> 8) & 0xff;
  bytes[offset + 1] = metaBytes.byteLength & 0xff;
  offset += 2;
  bytes.set(metaBytes, offset);
  offset += metaBytes.byteLength;
  bytes.set(payload, offset);
  return bytes;
}

export function decodeBrowserStreamFrame(bytes: Uint8Array): BrowserStreamFrame | null {
  if (bytes.byteLength < 4 || bytes[0] !== BrowserStreamOpcode.Frame) {
    return null;
  }
  const browserIdLength = bytes[1];
  const metaLengthOffset = 2 + browserIdLength;
  if (browserIdLength === 0 || bytes.byteLength < metaLengthOffset + 2) {
    return null;
  }
  const browserId = decodeAscii(bytes.subarray(2, metaLengthOffset));
  const metaLength = (bytes[metaLengthOffset] << 8) | bytes[metaLengthOffset + 1];
  const payloadOffset = metaLengthOffset + 2 + metaLength;
  if (bytes.byteLength < payloadOffset) {
    return null;
  }
  let parsedMeta: unknown;
  try {
    parsedMeta = JSON.parse(decodeAscii(bytes.subarray(metaLengthOffset + 2, payloadOffset)));
  } catch {
    return null;
  }
  const meta = BrowserStreamFrameMetaSchema.safeParse(parsedMeta);
  if (!meta.success) {
    return null;
  }
  return {
    opcode: BrowserStreamOpcode.Frame,
    browserId,
    meta: meta.data,
    payload: bytes.subarray(payloadOffset),
  };
}
