/**
 * Daseo delta 51: Codex-style adaptive pacing for streamed assistant text.
 *
 * A provider delivers a reply in bursts; drawing each burst whole makes the answer jump
 * forward a paragraph at a time. The Codex TUI instead commits one queued line per frame
 * tick ("smooth" gear) and drains the whole backlog at once when the queue grows deep or
 * old ("catch-up" gear), with hysteresis so the two gears do not flap. This module ports
 * that policy (openai/codex codex-rs/tui/src/streaming/chunking.rs, same thresholds).
 *
 * A GUI does not know where its text will wrap, so the unit here is a "line" of source
 * text: up to the next newline, or at most LINE_UNIT_MAX_CHARS ending on a space.
 */

const ENTER_QUEUE_DEPTH_LINES = 8;
const ENTER_OLDEST_AGE_MS = 120;
const EXIT_QUEUE_DEPTH_LINES = 2;
const EXIT_OLDEST_AGE_MS = 40;
const EXIT_HOLD_MS = 250;
const REENTER_CATCH_UP_HOLD_MS = 250;
const SEVERE_QUEUE_DEPTH_LINES = 64;
const SEVERE_OLDEST_AGE_MS = 300;

export const LINE_UNIT_MAX_CHARS = 80;
// A unit is cut at the last space within this many characters of the limit; a run of
// text with no space in reach (a URL, CJK without spaces) is cut at the limit itself.
const LINE_UNIT_MIN_BREAK_CHARS = 24;

export type PacingMode = "smooth" | "catch-up";

export interface QueueSnapshot {
  queuedLines: number;
  oldestAgeMs: number | null;
}

export class AdaptiveChunkingPolicy {
  private mode: PacingMode = "smooth";
  private belowExitThresholdSince: number | null = null;
  private lastCatchUpExitAt: number | null = null;

  getMode(): PacingMode {
    return this.mode;
  }

  reset(): void {
    this.mode = "smooth";
    this.belowExitThresholdSince = null;
    this.lastCatchUpExitAt = null;
  }

  /** Returns how many queued lines to reveal on this tick: 1 when smooth, all when catching up. */
  decide(snapshot: QueueSnapshot, nowMs: number): number {
    if (snapshot.queuedLines === 0) {
      if (this.mode === "catch-up") {
        this.lastCatchUpExitAt = nowMs;
      }
      this.mode = "smooth";
      this.belowExitThresholdSince = null;
      return 1;
    }
    if (this.mode === "smooth") {
      this.maybeEnterCatchUp(snapshot, nowMs);
    } else {
      this.maybeExitCatchUp(snapshot, nowMs);
    }
    return this.mode === "smooth" ? 1 : Math.max(1, snapshot.queuedLines);
  }

  private maybeEnterCatchUp(snapshot: QueueSnapshot, nowMs: number): void {
    if (!shouldEnterCatchUp(snapshot)) return;
    const reentryHoldActive =
      this.lastCatchUpExitAt !== null && nowMs - this.lastCatchUpExitAt < REENTER_CATCH_UP_HOLD_MS;
    if (reentryHoldActive && !isSevereBacklog(snapshot)) return;
    this.mode = "catch-up";
    this.belowExitThresholdSince = null;
    this.lastCatchUpExitAt = null;
  }

  private maybeExitCatchUp(snapshot: QueueSnapshot, nowMs: number): void {
    if (!shouldExitCatchUp(snapshot)) {
      this.belowExitThresholdSince = null;
      return;
    }
    if (this.belowExitThresholdSince === null) {
      this.belowExitThresholdSince = nowMs;
      return;
    }
    if (nowMs - this.belowExitThresholdSince >= EXIT_HOLD_MS) {
      this.mode = "smooth";
      this.belowExitThresholdSince = null;
      this.lastCatchUpExitAt = nowMs;
    }
  }
}

function shouldEnterCatchUp(snapshot: QueueSnapshot): boolean {
  return (
    snapshot.queuedLines >= ENTER_QUEUE_DEPTH_LINES ||
    (snapshot.oldestAgeMs !== null && snapshot.oldestAgeMs >= ENTER_OLDEST_AGE_MS)
  );
}

function shouldExitCatchUp(snapshot: QueueSnapshot): boolean {
  return (
    snapshot.queuedLines <= EXIT_QUEUE_DEPTH_LINES &&
    snapshot.oldestAgeMs !== null &&
    snapshot.oldestAgeMs <= EXIT_OLDEST_AGE_MS
  );
}

function isSevereBacklog(snapshot: QueueSnapshot): boolean {
  return (
    snapshot.queuedLines >= SEVERE_QUEUE_DEPTH_LINES ||
    (snapshot.oldestAgeMs !== null && snapshot.oldestAgeMs >= SEVERE_OLDEST_AGE_MS)
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** End index (exclusive) of the line unit that starts at `from`. */
export function nextLineUnitEnd(text: string, from: number): number {
  if (from >= text.length) return text.length;
  const limit = Math.min(text.length, from + LINE_UNIT_MAX_CHARS);
  const newline = text.indexOf("\n", from);
  if (newline !== -1 && newline < limit) {
    return newline + 1;
  }
  if (limit === text.length) {
    return limit;
  }
  const space = text.lastIndexOf(" ", limit - 1);
  if (space >= from + LINE_UNIT_MIN_BREAK_CHARS) {
    return space + 1;
  }
  // Never split a surrogate pair.
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/** Number of line units between `from` and the end of `text`, counted up to `cap`. */
export function countLineUnits(text: string, from: number, cap = SEVERE_QUEUE_DEPTH_LINES): number {
  let count = 0;
  let cursor = from;
  while (cursor < text.length && count < cap) {
    cursor = nextLineUnitEnd(text, cursor);
    count += 1;
  }
  return count;
}

/** Index the reveal advances to after showing `lines` more units from `from`. */
export function advanceLineUnits(text: string, from: number, lines: number): number {
  let cursor = from;
  for (let index = 0; index < lines && cursor < text.length; index += 1) {
    cursor = nextLineUnitEnd(text, cursor);
  }
  return cursor;
}
