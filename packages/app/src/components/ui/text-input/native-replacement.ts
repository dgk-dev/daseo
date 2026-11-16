export interface NativeTextReplacementTarget {
  clear?: () => void;
  replaceText?: (text: string, start: number, end: number) => void;
  setNativeProps: (props: { text: string; selection?: { start: number; end: number } }) => void;
  setSelection?: (start: number, end: number) => void;
}

export interface PendingNativeTextReplacement {
  previousText: string;
  expectedText: string;
}

export type NativeTextChangeResolution =
  | { action: "accept"; pending: null }
  | { action: "ignore"; pending: null }
  | { action: "reassert"; pending: PendingNativeTextReplacement };

/**
 * Replace native-owned text without turning the input into a controlled field.
 *
 * Mattermost's Android Fabric input exposes an event-count-aware command through
 * `replaceText`. Standard React Native inputs fall back to their public clear or
 * setNativeProps APIs.
 */
export function replaceNativeInputText(
  target: NativeTextReplacementTarget,
  text: string,
  selection?: { start: number; end: number },
): void {
  const start = selection?.start ?? text.length;
  const end = selection?.end ?? start;

  if (target.replaceText) {
    target.replaceText(text, start, end);
    return;
  }

  if (text.length === 0 && target.clear) {
    target.clear();
    target.setSelection?.(start, end);
    return;
  }

  target.setNativeProps({ text, ...(selection ? { selection } : {}) });
  if (selection) {
    target.setSelection?.(start, end);
  }
}

/**
 * The guard for a replacement about to be sent to the native input. Re-applying the text that a
 * replacement already in flight is waiting for keeps that replacement's guard: the draft echoes
 * every replacement back through `textReplacementKey`, and resetting the guard on that echo let
 * the late IME event it exists for put a sent prompt back into the composer (Daseo delta 96).
 */
export function createPendingNativeTextReplacement(
  previousText: string,
  expectedText: string,
  inFlight: PendingNativeTextReplacement | null = null,
): PendingNativeTextReplacement | null {
  if (previousText === expectedText) {
    return inFlight?.expectedText === expectedText ? inFlight : null;
  }
  return { previousText, expectedText };
}

/**
 * A native/IME change already queued before an imperative replacement may be
 * delivered after that replacement. Ignore the duplicate expected value and
 * reassert the replacement when the exact pre-replacement value arrives. Any
 * other value is new user input and must be accepted immediately.
 */
export function resolveNativeTextChangeAfterReplacement(
  pending: PendingNativeTextReplacement | null,
  nextText: string,
): NativeTextChangeResolution {
  if (!pending) {
    return { action: "accept", pending: null };
  }
  if (nextText === pending.expectedText) {
    return { action: "ignore", pending: null };
  }
  if (nextText === pending.previousText || isLateCommitOfReplacedText(pending, nextText)) {
    return { action: "reassert", pending };
  }
  return { action: "accept", pending: null };
}

const LATE_COMMIT_MIN_SHARED_LENGTH = 16;

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * A late IME commit rarely carries the replaced text unchanged: voice typing finalises its last
 * phrase when send is pressed (a revised word, an added full stop or space), so the event holds
 * the replaced prompt with a different tail. Such an event continues the replaced text, not the
 * replacement: it shares at least half of the replaced text (and 16 characters) from the start,
 * and more than it shares with the replacement. Typing after the replacement starts from the
 * replacement and never matches.
 */
function isLateCommitOfReplacedText(
  pending: PendingNativeTextReplacement,
  nextText: string,
): boolean {
  const replaced = pending.previousText;
  if (replaced.length < LATE_COMMIT_MIN_SHARED_LENGTH) return false;
  const shared = sharedPrefixLength(nextText, replaced);
  if (shared < Math.max(LATE_COMMIT_MIN_SHARED_LENGTH, Math.ceil(replaced.length / 2))) {
    return false;
  }
  return shared > sharedPrefixLength(nextText, pending.expectedText);
}
