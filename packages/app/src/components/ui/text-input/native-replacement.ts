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
  if (nextText === pending.previousText) {
    return { action: "reassert", pending };
  }
  return { action: "accept", pending: null };
}
