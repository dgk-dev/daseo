import { describe, expect, it } from "vitest";
import {
  buildToolRowInfo,
  formatTerminalDuration,
  resolveToolRowExitCode,
  ToolRunClock,
} from "./terminal-duration";

describe("formatTerminalDuration", () => {
  it("formats whole seconds, minutes and hours with aligned digits", () => {
    expect(formatTerminalDuration(0)).toBe("0s");
    expect(formatTerminalDuration(13_900)).toBe("13s");
    expect(formatTerminalDuration(65_000)).toBe("1min 05s");
    expect(formatTerminalDuration(133_000)).toBe("2min 13s");
    expect(formatTerminalDuration(3_720_000)).toBe("1h 02min");
  });

  it("shows tenths under a minute only when asked", () => {
    expect(formatTerminalDuration(41_230, { tenths: true })).toBe("41.2s");
    expect(formatTerminalDuration(6_800, { tenths: true })).toBe("6.8s");
    expect(formatTerminalDuration(59_960, { tenths: true })).toBe("59.9s");
    expect(formatTerminalDuration(65_400, { tenths: true })).toBe("1min 05s");
  });

  it("answers 0s for values that are not a duration", () => {
    expect(formatTerminalDuration(-5)).toBe("0s");
    expect(formatTerminalDuration(Number.NaN)).toBe("0s");
  });
});

describe("ToolRunClock", () => {
  const at = (ms: number) => new Date(ms);

  it("keeps the first running time and measures to the update that ended the call", () => {
    const clock = new ToolRunClock();
    expect(clock.observe({ itemId: "a", running: true, seenAt: at(1_000), now: 5_000 })).toEqual({
      startedAt: 1_000,
    });
    expect(clock.observe({ itemId: "a", running: true, seenAt: at(3_000), now: 5_000 })).toEqual({
      startedAt: 1_000,
    });
    expect(clock.observe({ itemId: "a", running: false, seenAt: at(42_200) })).toEqual({
      ranForMs: 41_200,
    });
    // Later renders of the finished row keep the same duration.
    expect(clock.observe({ itemId: "a", running: false, seenAt: at(42_200) })).toEqual({
      ranForMs: 41_200,
    });
  });

  it("gives no duration to a call that arrived already finished", () => {
    const clock = new ToolRunClock();
    expect(clock.observe({ itemId: "history", running: false, seenAt: at(9_000) })).toEqual({});
  });

  it("does not invent a duration when the timestamps run backwards", () => {
    const clock = new ToolRunClock();
    clock.observe({ itemId: "a", running: true, seenAt: at(10_000), now: 10_000 });
    expect(clock.observe({ itemId: "a", running: false, seenAt: at(4_000) })).toEqual({});
  });

  it("forgets the oldest finished calls past its limit", () => {
    const clock = new ToolRunClock(1);
    for (const id of ["a", "b"]) {
      clock.observe({ itemId: id, running: true, seenAt: at(0), now: 0 });
      clock.observe({ itemId: id, running: false, seenAt: at(1_000) });
    }
    expect(clock.observe({ itemId: "a", running: false, seenAt: at(1_000) })).toEqual({});
    expect(clock.observe({ itemId: "b", running: false, seenAt: at(1_000) })).toEqual({
      ranForMs: 1_000,
    });
  });
});

describe("resolveToolRowExitCode", () => {
  const shell = (exitCode?: number | null) => ({ type: "shell", exitCode });

  it("shows the provider's own number, zero included", () => {
    expect(resolveToolRowExitCode({ detail: shell(0), running: false })).toBe(0);
    expect(resolveToolRowExitCode({ detail: shell(127), running: false })).toBe(127);
  });

  it("shows nothing without a number, while running, or for other tools", () => {
    expect(resolveToolRowExitCode({ detail: shell(null), running: false })).toBeNull();
    expect(resolveToolRowExitCode({ detail: shell(), running: false })).toBeNull();
    expect(resolveToolRowExitCode({ detail: shell(0), running: true })).toBeNull();
    expect(resolveToolRowExitCode({ detail: { type: "edit" }, running: false })).toBeNull();
    expect(resolveToolRowExitCode({ detail: undefined, running: false })).toBeNull();
  });
});

describe("buildToolRowInfo", () => {
  it("shows exit code and measured duration on a finished command", () => {
    expect(
      buildToolRowInfo({
        reportedDurationMs: null,
        ranForMs: 41_230,
        exitCode: 0,
        status: "completed",
      }),
    ).toEqual({ durationLabel: "41.2s", exitCode: 0 });
    expect(
      buildToolRowInfo({
        reportedDurationMs: null,
        ranForMs: 6_800,
        exitCode: 1,
        status: "failed",
      }),
    ).toEqual({ durationLabel: "6.8s", exitCode: 1 });
  });

  it("prefers the duration the tool reported itself", () => {
    expect(
      buildToolRowInfo({
        reportedDurationMs: 65_000,
        ranForMs: 1_000,
        exitCode: null,
        status: "completed",
      }),
    ).toEqual({ durationLabel: "1min 05s" });
  });

  it("shows nothing it does not know: history rows have no duration, other tools no exit", () => {
    expect(
      buildToolRowInfo({
        reportedDurationMs: null,
        ranForMs: undefined,
        exitCode: null,
        status: "completed",
      }),
    ).toEqual({});
    expect(
      buildToolRowInfo({
        reportedDurationMs: null,
        ranForMs: undefined,
        exitCode: 2,
        status: "failed",
      }),
    ).toEqual({ exitCode: 2 });
  });

  it("leaves a running row to its live elapsed time", () => {
    expect(
      buildToolRowInfo({
        reportedDurationMs: 500,
        ranForMs: 900,
        exitCode: null,
        status: "running",
      }),
    ).toEqual({});
  });
});
