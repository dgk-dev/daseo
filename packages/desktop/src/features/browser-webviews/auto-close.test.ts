import { describe, expect, test } from "vitest";
import {
  readAutoCloseTimingOverride,
  readBrowserAutoCloseLogEntries,
  readBrowserIdList,
} from "./auto-close.js";

describe("agent tab auto-close IPC input (delta 98)", () => {
  test("accepts a list of browser ids and rejects anything else", () => {
    expect(readBrowserIdList([" a ", "b"])).toEqual(["a", "b"]);
    expect(readBrowserIdList([])).toEqual([]);
    expect(readBrowserIdList(["a", 3])).toBeNull();
    expect(readBrowserIdList(["a", "  "])).toBeNull();
    expect(readBrowserIdList("a")).toBeNull();
    expect(readBrowserIdList(Array.from({ length: 501 }, (_, index) => `id-${index}`))).toBeNull();
  });

  test("the E2E timing seam sets the sweep and the archived grace, each only when valid", () => {
    expect(readAutoCloseTimingOverride(undefined)).toEqual({});
    expect(readAutoCloseTimingOverride("3000")).toEqual({ sweepIntervalMs: 3000 });
    expect(readAutoCloseTimingOverride("3000,2000")).toEqual({
      sweepIntervalMs: 3000,
      archivedGraceMs: 2000,
    });
    expect(readAutoCloseTimingOverride("x,-1")).toEqual({});
  });

  test("logs only well-formed decisions, host only, whole hours", () => {
    const valid = {
      action: "would-close",
      browserId: "b1",
      workspaceId: "w1",
      reason: "creator-archived",
      creatorAgentId: "agent-1",
      idleHours: 25.7,
      host: "example.com",
    };
    expect(
      readBrowserAutoCloseLogEntries([
        valid,
        { ...valid, action: "delete" },
        { ...valid, reason: "because" },
        { ...valid, idleHours: Number.NaN },
        null,
      ]),
    ).toEqual([{ ...valid, idleHours: 25 }]);
    expect(readBrowserAutoCloseLogEntries({})).toEqual([]);
  });
});
