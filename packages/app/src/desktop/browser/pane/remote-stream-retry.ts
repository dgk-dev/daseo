export const REMOTE_STREAM_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function nextRemoteStreamRetry(input: { attempt: number }): {
  delayMs: number;
  nextAttempt: number;
} | null {
  const delayMs = REMOTE_STREAM_RETRY_DELAYS_MS[input.attempt];
  return delayMs === undefined ? null : { delayMs, nextAttempt: input.attempt + 1 };
}

/** Frames are monotonic for one host tab stream, including host-side restarts. */
export function shouldAcceptRemoteStreamSequence(
  lastSequence: number,
  nextSequence: number,
): boolean {
  return Number.isInteger(nextSequence) && nextSequence >= 0 && nextSequence > lastSequence;
}
