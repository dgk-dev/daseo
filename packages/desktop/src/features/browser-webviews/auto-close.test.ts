import { describe, expect, test } from "vitest";
import { readBrowserAutoCloseLogEntries, readBrowserIdList } from "./auto-close.js";

describe("agent tab auto-close IPC input (delta 98)", () => {
  test("accepts a list of browser ids and rejects anything else", () => {
    expect(readBrowserIdList([" a ", "b"])).toEqual(["a", "b"]);
    expect(readBrowserIdList([])).toEqual([]);
    expect(readBrowserIdList(["a", 3])).toBeNull();
    expect(readBrowserIdList(["a", "  "])).toBeNull();
    expect(readBrowserIdList("a")).toBeNull();
    expect(readBrowserIdList(Array.from({ length: 501 }, (_, index) => `id-${index}`))).toBeNull();
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
