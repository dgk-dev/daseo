import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAILLE_SPINNER_FRAME_MS,
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_STATIC,
  getBrailleDotMask,
} from "@/components/braille-spinner/frames";

// The Android spinner draws its frames natively, so its frame table and period are written in
// Kotlin. This pins them to the TS constants every other platform draws.
const viewKotlin = readFileSync(
  resolve(
    __dirname,
    "../../../modules/daseo-braille-spinner/android/src/main/java/sh/paseo/dgkbraillespinner/DaseoBrailleSpinnerView.kt",
  ),
  "utf8",
);

function hex(mask: number): string {
  return `0x${mask.toString(16).toUpperCase().padStart(2, "0")}`;
}

describe("Android braille spinner", () => {
  it("draws the same frames in the same order", () => {
    const masks = BRAILLE_SPINNER_FRAMES.map((glyph) => hex(getBrailleDotMask(glyph)));
    expect(viewKotlin).toContain(`val FRAME_MASKS = intArrayOf(${masks.join(", ")})`);
    expect(viewKotlin).toContain(
      `const val STATIC_MASK = ${hex(getBrailleDotMask(BRAILLE_SPINNER_STATIC))}`,
    );
  });

  it("steps on the same period", () => {
    expect(viewKotlin).toContain(`const val FRAME_MS = ${BRAILLE_SPINNER_FRAME_MS}L`);
  });
});
