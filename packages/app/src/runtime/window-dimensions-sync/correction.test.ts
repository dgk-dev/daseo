import { describe, expect, it } from "vitest";
import { resolveWindowCorrection } from "./correction";

const unfolded = { width: 874.67, height: 970.67 };
const cover = { width: 480, height: 1120 };

describe("resolveWindowCorrection", () => {
  it("replaces the unfolded size React Native kept after the Fold was closed", () => {
    expect(resolveWindowCorrection({ reactNativeWindow: unfolded, actualWindow: cover })).toEqual(
      cover,
    );
  });

  it("replaces the cover size React Native kept after the Fold was opened", () => {
    expect(resolveWindowCorrection({ reactNativeWindow: cover, actualWindow: unfolded })).toEqual(
      unfolded,
    );
  });

  it("leaves a window that already matches alone, rounding included", () => {
    expect(
      resolveWindowCorrection({
        reactNativeWindow: { width: 480, height: 1120 },
        actualWindow: { width: 480.4, height: 1120 },
      }),
    ).toBeNull();
  });

  it("does not act on a height-only difference", () => {
    expect(
      resolveWindowCorrection({
        reactNativeWindow: { width: 480, height: 1065 },
        actualWindow: { width: 480, height: 1120 },
      }),
    ).toBeNull();
  });

  it("ignores an actual window that has no size yet", () => {
    expect(
      resolveWindowCorrection({
        reactNativeWindow: unfolded,
        actualWindow: { width: 0, height: 0 },
      }),
    ).toBeNull();
  });
});
