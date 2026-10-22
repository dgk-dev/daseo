import { describe, expect, it } from "vitest";
import {
  AdaptiveChunkingPolicy,
  LINE_UNIT_MAX_CHARS,
  advanceLineUnits,
  countLineUnits,
  nextLineUnitEnd,
} from "./stream-pacing";

describe("AdaptiveChunkingPolicy (Codex thresholds)", () => {
  it("reveals one line per tick while the queue is shallow and fresh", () => {
    const policy = new AdaptiveChunkingPolicy();
    expect(policy.decide({ queuedLines: 3, oldestAgeMs: 10 }, 0)).toBe(1);
    expect(policy.getMode()).toBe("smooth");
  });

  it("catches up when 8 lines queue or the oldest waits 120 ms", () => {
    const deep = new AdaptiveChunkingPolicy();
    expect(deep.decide({ queuedLines: 8, oldestAgeMs: 10 }, 0)).toBe(8);
    expect(deep.getMode()).toBe("catch-up");

    const old = new AdaptiveChunkingPolicy();
    expect(old.decide({ queuedLines: 2, oldestAgeMs: 120 }, 0)).toBe(2);
    expect(old.getMode()).toBe("catch-up");
  });

  it("leaves catch-up only after 250 ms at or below 2 lines and 40 ms", () => {
    const policy = new AdaptiveChunkingPolicy();
    policy.decide({ queuedLines: 9, oldestAgeMs: 10 }, 0);
    policy.decide({ queuedLines: 1, oldestAgeMs: 20 }, 100);
    expect(policy.getMode()).toBe("catch-up");
    policy.decide({ queuedLines: 1, oldestAgeMs: 20 }, 349);
    expect(policy.getMode()).toBe("catch-up");
    policy.decide({ queuedLines: 1, oldestAgeMs: 20 }, 350);
    expect(policy.getMode()).toBe("smooth");
  });

  it("holds re-entry for 250 ms after an exit unless the backlog is severe", () => {
    const policy = new AdaptiveChunkingPolicy();
    policy.decide({ queuedLines: 9, oldestAgeMs: 10 }, 0);
    policy.decide({ queuedLines: 0, oldestAgeMs: null }, 10);
    expect(policy.getMode()).toBe("smooth");
    expect(policy.decide({ queuedLines: 9, oldestAgeMs: 10 }, 100)).toBe(1);
    expect(policy.decide({ queuedLines: 64, oldestAgeMs: 10 }, 120)).toBe(64);
    expect(policy.getMode()).toBe("catch-up");
  });
});

describe("line units", () => {
  it("ends a unit at a newline", () => {
    expect(nextLineUnitEnd("one\ntwo\n", 0)).toBe(4);
    expect(nextLineUnitEnd("one\ntwo\n", 4)).toBe(8);
  });

  it("breaks long prose at a space within the limit", () => {
    const text = `${"word ".repeat(40)}`;
    const end = nextLineUnitEnd(text, 0);
    expect(end).toBeLessThanOrEqual(LINE_UNIT_MAX_CHARS);
    expect(text[end - 1]).toBe(" ");
  });

  it("cuts a run without spaces at the limit and never inside a surrogate pair", () => {
    const run = "가".repeat(200);
    expect(nextLineUnitEnd(run, 0)).toBe(LINE_UNIT_MAX_CHARS);
    const emoji = `${"a".repeat(LINE_UNIT_MAX_CHARS - 1)}😀tail`;
    expect(nextLineUnitEnd(emoji, 0)).toBe(LINE_UNIT_MAX_CHARS - 1);
  });

  it("counts and advances by units", () => {
    const text = "a\nb\nc\nd";
    expect(countLineUnits(text, 0)).toBe(4);
    expect(advanceLineUnits(text, 0, 2)).toBe(4);
    expect(advanceLineUnits(text, 4, 10)).toBe(text.length);
  });
});
