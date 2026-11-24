import { describe, expect, it } from "vitest";
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_STATIC,
  getBrailleDotMask,
  getBrailleSpinnerFrameIndex,
} from "@/components/braille-spinner/frames";

describe("braille spinner frames", () => {
  it("picks the frame from the clock, so spinners mounted at different times are in phase", () => {
    expect(getBrailleSpinnerFrameIndex(0)).toBe(0);
    expect(getBrailleSpinnerFrameIndex(99)).toBe(0);
    expect(getBrailleSpinnerFrameIndex(100)).toBe(1);
    expect(getBrailleSpinnerFrameIndex(1_000)).toBe(0);
    expect(getBrailleSpinnerFrameIndex(12_345)).toBe(3);
  });

  it("uses only the six dots of a 2 x 3 cell", () => {
    for (const glyph of BRAILLE_SPINNER_FRAMES) {
      const mask = getBrailleDotMask(glyph);
      expect(mask).toBeGreaterThan(0);
      expect(mask & ~0x3f).toBe(0);
    }
    expect(getBrailleDotMask(BRAILLE_SPINNER_STATIC)).toBe(0x3f);
    expect(getBrailleDotMask("⠋")).toBe(0b001011);
  });
});
