import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import {
  SLACK_SCHEDULED_COMMAND_RELATIVE_PATH,
  SLACK_SCHEDULED_FILE_RELATIVE_PATH,
  SlackScheduledReader,
  normalizeSlackScheduledEntry,
} from "./slack-scheduled-reader.js";
import { handleScheduleSlackListRequest } from "./slack-scheduled-session.js";

const logger = pino({ level: "silent" });

// 2026-11-20 12:00 KST.
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const HOUR_S = 3600;
const LONG_TEXT = `${"첫 줄입니다 ".repeat(20)}\n둘째 줄 비밀 내용\n셋째 줄`;

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-slack-scheduled-"));
}

function writeRecord(home: string, entries: unknown): void {
  const file = path.join(home, SLACK_SCHEDULED_FILE_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entries));
}

function writeCommand(home: string, body: string): void {
  const file = path.join(home, SLACK_SCHEDULED_COMMAND_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// The record as pi-local wrote it before lane A added status (the shape on disk on 2026-11-20).
const OLD_SHAPE_RECORD = [
  {
    id: "Q_FUTURE",
    channel: "D123",
    as: "me",
    to: "yeomi@dfcorp.co.kr",
    postAt: NOW / 1000 + 5 * HOUR_S,
    text: LONG_TEXT,
    format: "mrkdwn",
    createdAt: NOW - 1000,
  },
  {
    id: "Q_PAST",
    channel: "C456",
    as: "bot",
    to: "#ax",
    postAt: NOW / 1000 - 2 * HOUR_S,
    text: "\n\n지난 알림\n본문",
    format: "mrkdwn",
    threadTs: "1.2",
    createdAt: NOW - 5000,
  },
];

describe("normalizeSlackScheduledEntry (delta 135)", () => {
  it("drops entries without an id or a post time", () => {
    expect(normalizeSlackScheduledEntry({ postAt: 1 }, NOW)).toBeNull();
    expect(normalizeSlackScheduledEntry({ id: "Q1" }, NOW)).toBeNull();
    expect(normalizeSlackScheduledEntry("Q1", NOW)).toBeNull();
  });

  it("keeps a known status, reads an unknown one as scheduled, and a past scheduled as unverified", () => {
    const future = NOW / 1000 + HOUR_S;
    const past = NOW / 1000 - HOUR_S;
    expect(
      normalizeSlackScheduledEntry({ id: "a", postAt: past, status: "sent" }, NOW)?.status,
    ).toBe("sent");
    expect(
      normalizeSlackScheduledEntry({ id: "b", postAt: future, status: "weird" }, NOW)?.status,
    ).toBe("scheduled");
    expect(normalizeSlackScheduledEntry({ id: "c", postAt: past }, NOW)?.status).toBe("unverified");
    expect(
      normalizeSlackScheduledEntry({ id: "d", postAt: past, status: "scheduled" }, NOW)?.status,
    ).toBe("unverified");
  });

  it("keeps only https permalinks and one line of error", () => {
    const entry = normalizeSlackScheduledEntry(
      {
        id: "a",
        postAt: 1,
        status: "failed",
        permalink: "javascript:alert(1)",
        error: "channel_not_found\nstack line",
      },
      NOW,
    );
    expect(entry?.permalink).toBeNull();
    expect(entry?.error).toBe("channel_not_found");
  });

  it("keeps only a Slack app link of the exact shape", () => {
    const appLink = "slack://channel?team=T02004LSA0L&id=D0AQ557U7U2&message=1795129200.272279";
    const read = (value: unknown) =>
      normalizeSlackScheduledEntry({ id: "a", postAt: 1, status: "sent", appLink: value }, NOW)
        ?.appLink;
    expect(read(appLink)).toBe(appLink);
    expect(read(`${appLink}&x=1`)).toBeNull();
    expect(read("slack://open?team=T02004LSA0L")).toBeNull();
    expect(read("javascript:alert(1)")).toBeNull();
    expect(read(undefined)).toBeNull();
  });
});

describe("normalizeSlackScheduledEntry text and mentions (delta 135, 2026-11-23)", () => {
  it("passes a 40,000-character text whole, cuts a longer one there, and keeps only names of ids the text mentions", () => {
    const full = normalizeSlackScheduledEntry(
      { id: "a", postAt: 1, text: "가".repeat(40_000) },
      NOW,
    );
    expect(full?.text).toBe("가".repeat(40_000));
    const entry = normalizeSlackScheduledEntry(
      {
        id: "a",
        postAt: 1,
        text: `<@U0DOYOUNG> <@W0KIM0001|김> ${"가".repeat(41_000)}`,
        mentions: {
          U0DOYOUNG: "  도영 ",
          W0KIM0001: "김",
          U0ABSENT1: "없는 사람",
          "<script>": "x",
          U0EMPTY01: "  ",
        },
      },
      NOW,
    );
    expect(Array.from(entry?.text ?? "")).toHaveLength(40_000);
    expect(entry?.text?.endsWith("…")).toBe(true);
    expect(entry?.mentions).toEqual({ U0DOYOUNG: "도영", W0KIM0001: "김" });
  });

  it("reads the record's stored mentionNames on the file path, and nothing without a text", () => {
    const fromFile = normalizeSlackScheduledEntry(
      { id: "a", postAt: 1, text: "<@U0DOYOUNG> 확인", mentionNames: { U0DOYOUNG: "도영" } },
      NOW,
    );
    expect(fromFile?.mentions).toEqual({ U0DOYOUNG: "도영" });
    const noText = normalizeSlackScheduledEntry(
      { id: "a", postAt: 1, firstLine: "첫 줄", mentions: { U0DOYOUNG: "도영" } },
      NOW,
    );
    expect([noText?.text, noText?.mentions]).toEqual([null, null]);
  });
});

describe("SlackScheduledReader (delta 135)", () => {
  it("reads an old-shape record when the reconcile command is missing, with the full text", async () => {
    const home = createHome();
    writeRecord(home, OLD_SHAPE_RECORD);
    const reader = new SlackScheduledReader({ logger, homeDir: home, now: () => NOW });

    const result = await reader.list();

    expect(result.source).toBe("file");
    expect(result.warning).toBeNull();
    expect(
      result.entries.map((entry) => [entry.id, entry.status, entry.as, entry.toLabel]),
    ).toEqual([
      ["Q_FUTURE", "scheduled", "me", "yeomi@dfcorp.co.kr"],
      ["Q_PAST", "unverified", "bot", "#ax"],
    ]);
    expect(result.entries[1]?.firstLine).toBe("지난 알림");
    const future = result.entries[0];
    expect(Array.from(future?.firstLine ?? "").length).toBeLessThanOrEqual(80);
    // 2026-11-23: the whole message leaves the daemon (the owner reads it in his own app).
    expect(future?.text).toBe(LONG_TEXT);
    expect(future?.mentions).toBeNull();
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("threadTs");
    expect(wire).not.toContain("mentionNames");
  });

  it("answers an empty list when neither the command nor the record exists", async () => {
    const reader = new SlackScheduledReader({ logger, homeDir: createHome(), now: () => NOW });
    expect(await reader.list()).toEqual({
      entries: [],
      source: "file",
      fetchedAt: NOW,
      warning: null,
    });
  });

  it("uses the reconcile command's entries when it succeeds", async () => {
    const home = createHome();
    writeRecord(home, OLD_SHAPE_RECORD);
    writeCommand(
      home,
      `if (!process.argv.includes("--json")) process.exit(3);
process.stdout.write(JSON.stringify({
  reconciledAt: ${NOW},
  warning: "one channel unreadable",
  entries: [
    { id: "Q_SENT", as: "me", to: "D1", toLabel: "김여미 이사 (DM)", channel: "D1",
      postAt: ${NOW / 1000 - HOUR_S}, firstLine: "보낸 글", status: "sent", createdAt: 1,
      resolvedAt: ${NOW - 10}, permalink: "https://dfcorp.slack.com/archives/D1/p1",
      appLink: "slack://channel?team=T02004LSA0L&id=D1AB&message=1795129200.272279" },
  ],
}));`,
    );
    const reader = new SlackScheduledReader({ logger, homeDir: home, now: () => NOW });

    const result = await reader.list();

    expect(result.source).toBe("command");
    expect(result.warning).toBe("one channel unreadable");
    expect(result.entries).toEqual([
      {
        id: "Q_SENT",
        as: "me",
        toLabel: "김여미 이사 (DM)",
        channel: "D1",
        postAt: NOW / 1000 - HOUR_S,
        firstLine: "보낸 글",
        status: "sent",
        createdAt: 1,
        resolvedAt: NOW - 10,
        permalink: "https://dfcorp.slack.com/archives/D1/p1",
        appLink: "slack://channel?team=T02004LSA0L&id=D1AB&message=1795129200.272279",
        text: null,
        mentions: null,
        error: null,
        replacedBy: null,
      },
    ]);
  });

  it("falls back to the record when the command fails, and says so", async () => {
    const home = createHome();
    writeRecord(home, OLD_SHAPE_RECORD);
    writeCommand(home, `process.stderr.write("boom"); process.exit(1);`);
    const reader = new SlackScheduledReader({ logger, homeDir: home, now: () => NOW });

    const result = await reader.list();

    expect(result.source).toBe("file");
    expect(result.warning).toMatch(/^Slack check failed: /);
    expect(result.entries.map((entry) => entry.id)).toEqual(["Q_FUTURE", "Q_PAST"]);
  });

  it("falls back to the record when the command prints something that is not the list", async () => {
    const home = createHome();
    writeRecord(home, OLD_SHAPE_RECORD);
    writeCommand(home, `process.stdout.write("not json");`);
    const reader = new SlackScheduledReader({ logger, homeDir: home, now: () => NOW });

    expect((await reader.list()).source).toBe("file");
  });

  it("caches a result for 60 seconds and shares one read between concurrent callers", async () => {
    const home = createHome();
    writeCommand(home, "unused");
    let now = NOW;
    let runs = 0;
    const reader = new SlackScheduledReader({
      logger,
      homeDir: home,
      now: () => now,
      runCommand: async () => {
        runs += 1;
        return { stdout: JSON.stringify({ entries: [] }) };
      },
    });

    await Promise.all([reader.list(), reader.list()]);
    expect(runs).toBe(1);
    now += 59_000;
    await reader.list();
    expect(runs).toBe(1);
    now += 2_000;
    await reader.list();
    expect(runs).toBe(2);
  });

  it("reads again after invalidate(), and does not cache a read that started before it", async () => {
    const home = createHome();
    writeCommand(home, "unused");
    let runs = 0;
    let release: () => void = () => {};
    const reader = new SlackScheduledReader({
      logger,
      homeDir: home,
      now: () => NOW,
      runCommand: async () => {
        runs += 1;
        if (runs === 2) await new Promise<void>((resolve) => (release = resolve));
        return { stdout: JSON.stringify({ entries: [] }) };
      },
    });
    await reader.list();
    reader.invalidate();
    const stale = reader.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    reader.invalidate();
    release();
    await stale;
    await reader.list();
    expect(runs).toBe(3);
    await reader.list();
    expect(runs).toBe(3);
  });

  it("rejects an unreadable record instead of answering an empty list", async () => {
    const home = createHome();
    const file = path.join(home, SLACK_SCHEDULED_FILE_RELATIVE_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken");
    const reader = new SlackScheduledReader({ logger, homeDir: home, now: () => NOW });

    await expect(reader.list()).rejects.toThrow();
  });
});

describe("handleScheduleSlackListRequest (delta 135)", () => {
  it("answers the list with the request id", async () => {
    const home = createHome();
    writeRecord(home, OLD_SHAPE_RECORD);
    const emitted: SessionOutboundMessage[] = [];
    await handleScheduleSlackListRequest({
      reader: new SlackScheduledReader({ logger, homeDir: home, now: () => NOW }),
      request: { type: "schedule.slack.list.request", requestId: "r1" },
      emit: (message) => emitted.push(message),
      logger,
    });
    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message?.type !== "schedule.slack.list.response") throw new Error("wrong response");
    expect(message.payload.requestId).toBe("r1");
    expect(message.payload.error).toBeNull();
    expect(message.payload.source).toBe("file");
    expect(message.payload.entries).toHaveLength(2);
  });

  it("answers an error when the record cannot be read or the host has no reader", async () => {
    const home = createHome();
    const file = path.join(home, SLACK_SCHEDULED_FILE_RELATIVE_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken");
    for (const reader of [
      new SlackScheduledReader({ logger, homeDir: home, now: () => NOW }),
      null,
    ]) {
      const emitted: SessionOutboundMessage[] = [];
      await handleScheduleSlackListRequest({
        reader,
        request: { type: "schedule.slack.list.request", requestId: "r2" },
        emit: (message) => emitted.push(message),
        logger,
      });
      const message = emitted[0];
      if (message?.type !== "schedule.slack.list.response") throw new Error("wrong response");
      expect(message.payload.error).toEqual(expect.any(String));
      expect(message.payload.entries).toEqual([]);
    }
  });
});
