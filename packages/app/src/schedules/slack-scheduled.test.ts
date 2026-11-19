import type { SlackScheduledEntry } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  fetchSlackScheduled,
  formatSlackPostTime,
  partitionSlackScheduled,
  slackEntryLink,
  slackSenderLabel,
  slackStatusBadge,
  type SlackScheduledRuntime,
} from "./slack-scheduled";

// 2026-11-20 12:00 KST.
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

function entry(overrides: Partial<SlackScheduledEntry>): SlackScheduledEntry {
  return {
    id: "Q1",
    as: "me",
    toLabel: "김여미 이사 (DM)",
    channel: "D1",
    postAt: NOW / 1000 + HOUR_S,
    firstLine: "첫 줄",
    status: "scheduled",
    createdAt: NOW - 1000,
    ...overrides,
  };
}

describe("partitionSlackScheduled (delta 135)", () => {
  it("puts scheduled first, soonest first, and the rest newest first within 30 days", () => {
    const entries = [
      entry({ id: "later", postAt: NOW / 1000 + 5 * HOUR_S }),
      entry({ id: "sooner", postAt: NOW / 1000 + HOUR_S }),
      entry({ id: "sent-old", status: "sent", postAt: NOW / 1000 - 3 * DAY_S }),
      entry({ id: "unverified", status: "unverified", postAt: NOW / 1000 - HOUR_S }),
      entry({ id: "failed", status: "failed", postAt: NOW / 1000 - 2 * HOUR_S }),
      entry({ id: "too-old", status: "cancelled", postAt: NOW / 1000 - 31 * DAY_S }),
      entry({ id: "replaced", status: "replaced", postAt: NOW / 1000 - DAY_S }),
    ];
    const { upcoming, past } = partitionSlackScheduled(entries, NOW);
    expect(upcoming.map((item) => item.id)).toEqual(["sooner", "later"]);
    expect(past.map((item) => item.id)).toEqual(["unverified", "failed", "replaced", "sent-old"]);
  });

  it("returns two empty sections for an empty list", () => {
    expect(partitionSlackScheduled([], NOW)).toEqual({ upcoming: [], past: [] });
  });
});

describe("Slack row labels (delta 135)", () => {
  it("maps every status to a chip with the schedule rows' colour meanings", () => {
    expect(slackStatusBadge("scheduled")).toEqual({ label: "예정", variant: "success" });
    expect(slackStatusBadge("sent")).toEqual({ label: "발송됨", variant: "muted" });
    expect(slackStatusBadge("cancelled")).toEqual({ label: "취소됨", variant: "muted" });
    expect(slackStatusBadge("failed")).toEqual({ label: "실패", variant: "error" });
    expect(slackStatusBadge("replaced")).toEqual({ label: "바뀜", variant: "muted" });
    expect(slackStatusBadge("unverified")).toEqual({ label: "확인 전", variant: "muted" });
    expect(slackStatusBadge("something-new")).toEqual({ label: "확인 전", variant: "muted" });
  });

  it("names the sender", () => {
    expect(slackSenderLabel("me")).toBe("본인");
    expect(slackSenderLabel("bot")).toBe("알림봇");
  });

  it("prints the post time in Korea time", () => {
    // 2026-11-19T23:00Z is 2026-11-20 08:00 KST.
    expect(formatSlackPostTime(Date.UTC(2026, 10, 19, 23, 0, 0) / 1000)).toBe("11/20 08:00");
  });

  it("links only a sent message with a permalink", () => {
    const permalink = "https://dfcorp.slack.com/archives/D1/p1";
    expect(slackEntryLink(entry({ status: "sent", permalink }))).toBe(permalink);
    expect(slackEntryLink(entry({ status: "sent", permalink: null }))).toBeNull();
    expect(slackEntryLink(entry({ status: "failed", permalink }))).toBeNull();
  });
});

function runtime(
  responses: Record<string, () => Promise<unknown>>,
  offline: string[] = [],
): SlackScheduledRuntime {
  return {
    isOnline: (serverId) => !offline.includes(serverId),
    getClient: (serverId) => {
      const respond = responses[serverId];
      if (!respond) return null;
      return {
        listSlackScheduled: respond as never,
      };
    },
  };
}

function payload(entries: SlackScheduledEntry[], extra: Record<string, unknown> = {}) {
  return async () => ({
    requestId: "r",
    entries,
    source: "file",
    fetchedAt: NOW,
    warning: null,
    error: null,
    ...extra,
  });
}

describe("fetchSlackScheduled (delta 135)", () => {
  const hosts = [
    { serverId: "a", serverName: "Mac" },
    { serverId: "b", serverName: "Mac (relay)" },
    { serverId: "c", serverName: "Off" },
  ];

  it("merges hosts, keeps one row per id, skips offline hosts, and collects warnings", async () => {
    const result = await fetchSlackScheduled({
      hosts,
      runtime: runtime(
        {
          a: payload([entry({ id: "Q1" })], { warning: "Slack check failed: timeout" }),
          b: payload([entry({ id: "Q1" }), entry({ id: "Q2" })]),
          c: payload([entry({ id: "Q3" })]),
        },
        ["c"],
      ),
    });
    expect(result.entries.map((item) => [item.id, item.serverId])).toEqual([
      ["Q1", "a"],
      ["Q2", "b"],
    ]);
    expect(result.warnings).toEqual(["Slack check failed: timeout"]);
    expect(result.hostErrors).toEqual([]);
  });

  it("reports a failing host and throws only when every asked host failed", async () => {
    const partial = await fetchSlackScheduled({
      hosts: hosts.slice(0, 2),
      runtime: runtime({
        a: payload([], { error: "record unreadable" }),
        b: payload([entry({ id: "Q2" })]),
      }),
    });
    expect(partial.hostErrors).toEqual([
      { serverId: "a", serverName: "Mac", message: "record unreadable" },
    ]);
    expect(partial.entries.map((item) => item.id)).toEqual(["Q2"]);

    await expect(
      fetchSlackScheduled({
        hosts: hosts.slice(0, 1),
        runtime: runtime({ a: async () => Promise.reject(new Error("socket closed")) }),
      }),
    ).rejects.toThrow("Could not load scheduled Slack messages");
  });
});
