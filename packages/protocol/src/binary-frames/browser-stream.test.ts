import { describe, expect, test } from "vitest";
import {
  BrowserStreamOpcode,
  decodeBrowserStreamFrame,
  encodeBrowserStreamFrame,
} from "./browser-stream.js";
import { decodeBinaryFrame } from "./demux.js";

const BROWSER_ID = "0b54f9a2-9d1c-4f6e-89ab-1234567890ab";

describe("browser stream frames", () => {
  test("round-trips a frame through encode and decode", () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
    const bytes = encodeBrowserStreamFrame({
      browserId: BROWSER_ID,
      meta: { seq: 41, width: 1179, height: 2556 },
      payload,
    });

    const frame = decodeBrowserStreamFrame(bytes);
    expect(frame).not.toBeNull();
    expect(frame?.opcode).toBe(BrowserStreamOpcode.Frame);
    expect(frame?.browserId).toBe(BROWSER_ID);
    expect(frame?.meta).toEqual({ seq: 41, width: 1179, height: 2556 });
    expect(Array.from(frame?.payload ?? [])).toEqual(Array.from(payload));
  });

  test("demuxes through the shared binary frame decoder", () => {
    const bytes = encodeBrowserStreamFrame({
      browserId: BROWSER_ID,
      meta: { seq: 1, width: 800, height: 600 },
      payload: new Uint8Array([1, 2, 3]),
    });

    const decoded = decodeBinaryFrame(bytes);
    expect(decoded?.kind).toBe("browser_stream");
    if (decoded?.kind === "browser_stream") {
      expect(decoded.frame.browserId).toBe(BROWSER_ID);
    }
  });

  test("rejects truncated and foreign frames", () => {
    const bytes = encodeBrowserStreamFrame({
      browserId: BROWSER_ID,
      meta: { seq: 1, width: 800, height: 600 },
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(decodeBrowserStreamFrame(bytes.subarray(0, 8))).toBeNull();
    expect(decodeBrowserStreamFrame(new Uint8Array([0x01, 0x00, 0x61]))).toBeNull();
    expect(decodeBrowserStreamFrame(new Uint8Array([]))).toBeNull();
  });

  test("rejects frames with invalid metadata", () => {
    const bytes = encodeBrowserStreamFrame({
      browserId: BROWSER_ID,
      meta: { seq: 1, width: 800, height: 600 },
      payload: new Uint8Array(0),
    });
    // Corrupt the metadata JSON in place.
    const metaOffset = 2 + BROWSER_ID.length + 2;
    bytes[metaOffset] = 0x21;
    expect(decodeBrowserStreamFrame(bytes)).toBeNull();
  });

  test("refuses non-ASCII browser ids at encode time", () => {
    expect(() =>
      encodeBrowserStreamFrame({
        browserId: "브라우저",
        meta: { seq: 1, width: 10, height: 10 },
        payload: new Uint8Array(0),
      }),
    ).toThrow();
  });
});
