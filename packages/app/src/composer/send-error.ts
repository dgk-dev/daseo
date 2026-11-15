/**
 * A send error stays until the user edits the input. The automatic restore of a failed
 * message also changes the input, in the same update that sets the error, so the input seen
 * together with the error first is the baseline, and only a later change clears it.
 */
export interface SendErrorAnchor {
  error: string;
  input: string;
}

export function resolveSendErrorAfterInputChange(input: {
  error: string | null;
  userInput: string;
  anchor: SendErrorAnchor | null;
}): { anchor: SendErrorAnchor | null; clear: boolean } {
  if (!input.error) return { anchor: null, clear: false };
  if (!input.anchor || input.anchor.error !== input.error) {
    return { anchor: { error: input.error, input: input.userInput }, clear: false };
  }
  if (input.userInput !== input.anchor.input) return { anchor: null, clear: true };
  return { anchor: input.anchor, clear: false };
}
