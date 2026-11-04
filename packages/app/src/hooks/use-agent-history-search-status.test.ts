import type { AgentHistorySearchStatus } from "@getpaseo/protocol/messages";
import { beforeAll, describe, expect, it } from "vitest";

(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

let summarizeAgentHistorySearchStatus: (typeof import("./use-agent-history-search-status"))["summarizeAgentHistorySearchStatus"];

beforeAll(async () => {
  ({ summarizeAgentHistorySearchStatus } = await import("./use-agent-history-search-status"));
});

function status(
  keyword: Partial<AgentHistorySearchStatus["keyword"]>,
  semantic: Partial<AgentHistorySearchStatus["semantic"]>,
): AgentHistorySearchStatus {
  return {
    keyword: { state: "ready", indexedSessions: 10, totalSessions: 10, ...keyword },
    semantic: { state: "ready", embeddedSessions: 10, totalSessions: 10, ...semantic },
  };
}

describe("summarizeAgentHistorySearchStatus", () => {
  it("reports keyword indexing across hosts and the download progress first", () => {
    expect(
      summarizeAgentHistorySearchStatus([
        status(
          { state: "indexing", indexedSessions: 120, totalSessions: 540 },
          {
            state: "downloading",
            downloadedBytes: 34,
            totalBytes: 100,
          },
        ),
        status({}, {}),
      ]),
    ).toEqual({
      keywordIndexing: { indexed: 130, total: 550 },
      semantic: { state: "downloading", percent: 34 },
    });
  });

  it("says nothing once every host is ready, and reads unknown states as off", () => {
    expect(summarizeAgentHistorySearchStatus([status({}, {})])).toEqual({
      keywordIndexing: null,
      semantic: { state: "ready" },
    });
    expect(summarizeAgentHistorySearchStatus([status({}, { state: "a-later-state" })])).toEqual({
      keywordIndexing: null,
      semantic: { state: "off" },
    });
    expect(summarizeAgentHistorySearchStatus([])).toBeNull();
  });

  it("reports a failed model so the screen can say results are keyword-only", () => {
    expect(
      summarizeAgentHistorySearchStatus([status({}, { state: "failed", error: "offline" })]),
    ).toEqual({ keywordIndexing: null, semantic: { state: "failed" } });
  });
});
