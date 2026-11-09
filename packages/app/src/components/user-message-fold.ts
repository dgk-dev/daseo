import { PROSE_MEASURE_CELLS } from "@/constants/layout";

/**
 * A long submitted prompt folds to its first USER_MESSAGE_FOLD_LINES lines behind "Show full
 * message" (the Ovis/herdr web UI fold for user turns), so a pasted log or a long dictated
 * prompt does not push the answer screens away.
 *
 * Only a message that is longer than the fold even in the widest bubble folds, so the toggle
 * never appears on a message it would not shorten. The estimate counts wrapped lines at the
 * widest bubble's column count, a CJK character taking two columns.
 */
export const USER_MESSAGE_FOLD_LINES = 12;

// The prompt wraps at the prose measure (Daseo delta 89), PROSE_MEASURE_CELLS monospace cells
// at any font size.
const WIDEST_BUBBLE_COLUMNS = PROSE_MEASURE_CELLS;

function isWideCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals through Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extension planes
  );
}

function columnsOf(line: string): number {
  let columns = 0;
  for (const character of line) {
    columns += isWideCharacter(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return columns;
}

export function estimateWidestBubbleLines(text: string): number {
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil(columnsOf(line) / WIDEST_BUBBLE_COLUMNS));
  }
  return lines;
}

export function shouldFoldUserMessage(text: string): boolean {
  return estimateWidestBubbleLines(text.trimEnd()) > USER_MESSAGE_FOLD_LINES;
}
