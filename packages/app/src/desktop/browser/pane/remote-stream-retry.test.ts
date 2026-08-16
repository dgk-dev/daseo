import { describe, expect, test } from "vitest";
import {
  nextRemoteStreamRetry,
  REMOTE_STREAM_RETRY_DELAYS_MS,
  shouldAcceptRemoteStreamSequence,
} from "./remote-stream-retry";

describe("remote browser stream recovery", () => {
  test("uses bounded exponential retry delays and then hands control back", () => {
    expect(
      REMOTE_STREAM_RETRY_DELAYS_MS.map((_delay, attempt) => nextRemoteStreamRetry({ attempt })),
    ).toEqual([
      { delayMs: 500, nextAttempt: 1 },
      { delayMs: 1_000, nextAttempt: 2 },
      { delayMs: 2_000, nextAttempt: 3 },
      { delayMs: 4_000, nextAttempt: 4 },
      { delayMs: 8_000, nextAttempt: 5 },
    ]);
    expect(nextRemoteStreamRetry({ attempt: REMOTE_STREAM_RETRY_DELAYS_MS.length })).toBeNull();
  });

  test("drops duplicate and out-of-order frames", () => {
    expect(shouldAcceptRemoteStreamSequence(10, 11)).toBe(true);
    expect(shouldAcceptRemoteStreamSequence(10, 10)).toBe(false);
    expect(shouldAcceptRemoteStreamSequence(10, 9)).toBe(false);
    expect(shouldAcceptRemoteStreamSequence(10, Number.NaN)).toBe(false);
  });
});
