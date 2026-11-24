/**
 * Daseo: the one loading and running motion in the app. Every spinner draws these frames, one per
 * `BRAILLE_SPINNER_FRAME_MS`, all in phase: the frame is a function of the clock, never of when a
 * spinner mounted. Under reduce motion, or while the spinner cannot be seen, it shows the static
 * all-dots glyph. The Android view draws the same frames as dots; `native-contract.test.ts` pins
 * its Kotlin table and period to these constants.
 */
export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const BRAILLE_SPINNER_STATIC = "⠿";
export const BRAILLE_SPINNER_FRAME_MS = 100;

const BRAILLE_PATTERN_BLANK = 0x2800;

/** The frame index on the shared clock at `nowMs`. */
export function getBrailleSpinnerFrameIndex(nowMs: number): number {
  return Math.floor(nowMs / BRAILLE_SPINNER_FRAME_MS) % BRAILLE_SPINNER_FRAMES.length;
}

/** The raised dots of a braille glyph as Unicode's bit mask: bit 0 is dot 1 … bit 5 is dot 6. */
export function getBrailleDotMask(glyph: string): number {
  const codePoint = glyph.codePointAt(0);
  if (codePoint === undefined) throw new Error("empty braille glyph");
  return codePoint - BRAILLE_PATTERN_BLANK;
}
