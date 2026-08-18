import { describe, expect, test } from "vitest";
import {
  assertImageSourceBudget,
  estimateDataUrlBytes,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SOURCE_BYTES,
} from "./image-budget";

describe("image resource budget", () => {
  test("rejects oversized source bytes before decode", () => {
    expect(() =>
      assertImageSourceBudget({ byteSize: MAX_IMAGE_SOURCE_BYTES + 1, label: "huge.png" }),
    ).toThrow("safety limit");
    expect(() =>
      assertImageSourceBudget({ byteSize: MAX_IMAGE_SOURCE_BYTES, label: "safe.png" }),
    ).not.toThrow();
  });

  test("rejects decoded pixel bombs independently of compressed bytes", () => {
    expect(() =>
      assertImageSourceBudget({ byteSize: 1024, width: MAX_IMAGE_PIXELS + 1, height: 1 }),
    ).toThrow("decoded-pixel safety limit");
  });

  test("estimates base64 data URL bytes without decoding it", () => {
    expect(estimateDataUrlBytes("data:image/png;base64,aGVsbG8=")).toBe(5);
  });
});
