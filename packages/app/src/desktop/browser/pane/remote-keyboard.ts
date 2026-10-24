// Daseo delta 60: the phone types into the streamed page through an invisible text field.
// The field's text is mirrored into the page by replaying the difference: delete what the
// page still shows past the common prefix, then insert the new tail. An IME that rewrites
// the last syllable while composing Hangul (ㅎ → 하 → 한) becomes one Backspace plus one
// insert per step, which is reliable in a browser field, unlike a terminal where Orca had to
// hold composed text back (stablyai/orca #7011, #7183).

export interface RemoteTypingStep {
  deleteCount: number;
  insert: string;
}

/** The edit that turns `previous` (what the page shows) into `next` (what the field holds). */
export function diffTypedText(previous: string, next: string): RemoteTypingStep {
  if (previous === next) {
    return { deleteCount: 0, insert: "" };
  }
  const before = Array.from(previous);
  const after = Array.from(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  return { deleteCount: before.length - prefix, insert: after.slice(prefix).join("") };
}

const HANGUL_JAMO = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]$/;
const HANGUL_SYLLABLE = /[가-힣]$/;
const RESET_AFTER_CODE_POINTS = 120;

/**
 * Whether the mirrored field can be emptied now without disturbing the IME. The field is
 * cleared once in a while so a long session does not grow it forever; clearing mid-syllable
 * would make the keyboard start a new syllable on the next key, so it waits for a boundary.
 */
export function shouldResetTypedText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  if (Array.from(text).length < RESET_AFTER_CODE_POINTS) {
    return false;
  }
  if (HANGUL_JAMO.test(text) || HANGUL_SYLLABLE.test(text)) {
    return false;
  }
  return /[\s.,!?;:)\]}]$/.test(text);
}
