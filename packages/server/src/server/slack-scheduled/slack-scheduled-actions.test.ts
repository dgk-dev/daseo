import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import {
  SLACK_SCHEDULED_ACT_RELATIVE_PATH,
  SlackScheduledActions,
  parseSlackScheduledActOutput,
  validateSlackScheduledActRequest,
} from "./slack-scheduled-actions.js";
import {
  handleScheduleSlackCancelRequest,
  handleScheduleSlackUpdateRequest,
} from "./slack-scheduled-session.js";

const logger = pino({ level: "silent" });
// 2026-11-23 12:00 KST.
const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const LATER_S = NOW / 1000 + 3600;

function homeWithScript(body: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-slack-act-"));
  const file = path.join(home, SLACK_SCHEDULED_ACT_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return home;
}

// Answers like pi-local's act script: refuses inside an agent session, echoes what it was asked.
const FAKE_SCRIPT = `
let raw = "";
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  if (process.env.PASEO_AGENT_ID || process.env.PI_CODING_AGENT || process.env.CLAUDECODE) {
    process.stdout.write(JSON.stringify({ ok: false, error: "agent" }) + "\\n");
    return;
  }
  const request = JSON.parse(raw);
  const argvHasText = process.argv.slice(2).some((arg) => arg.includes("비밀"));
  if (request.action === "cancel") process.stdout.write(JSON.stringify({ ok: true, action: "cancel", id: request.id }) + "\\n");
  else process.stdout.write(JSON.stringify({ ok: !argvHasText, action: "change", id: request.id, newId: "QNEW000001", postAt: request.postAt }) + "\\n");
});`;

describe("validateSlackScheduledActRequest (delta 135, 2026-11-23)", () => {
  it("accepts a scheduled id and a future whole-second time or non-empty text", () => {
    expect(validateSlackScheduledActRequest({ action: "cancel", id: "Q0ABC1234" }, NOW)).toBeNull();
    expect(
      validateSlackScheduledActRequest({ action: "change", id: "Q0ABC1234", postAt: LATER_S }, NOW),
    ).toBeNull();
    expect(
      validateSlackScheduledActRequest({ action: "change", id: "Q0ABC1234", text: "글" }, NOW),
    ).toBeNull();
  });

  it("refuses a bad id, nothing to change, a past or fractional time, and empty or long text", () => {
    const refused = (request: Parameters<typeof validateSlackScheduledActRequest>[0]) =>
      validateSlackScheduledActRequest(request, NOW);
    expect(refused({ action: "cancel", id: "../etc" })).toMatch(/id/);
    expect(refused({ action: "cancel", id: "Q12" })).toMatch(/id/);
    expect(refused({ action: "change", id: "Q0ABC1234" })).toMatch(/new time, a new text/);
    expect(refused({ action: "change", id: "Q0ABC1234", postAt: NOW / 1000 - 1 })).toMatch(/past/);
    expect(refused({ action: "change", id: "Q0ABC1234", postAt: LATER_S + 0.5 })).toMatch(/whole/);
    expect(refused({ action: "change", id: "Q0ABC1234", postAt: Number.NaN })).toMatch(/whole/);
    expect(refused({ action: "change", id: "Q0ABC1234", text: "   " })).toMatch(/empty/);
    expect(refused({ action: "change", id: "Q0ABC1234", text: "x".repeat(40_001) })).toMatch(
      /longer/,
    );
  });
});

describe("parseSlackScheduledActOutput (delta 135, 2026-11-23)", () => {
  it("reads the last line and keeps one line of a failure", () => {
    expect(parseSlackScheduledActOutput('noise\n{"ok":true,"newId":"QNEW000001"}\n')).toEqual({
      ok: true,
      newId: "QNEW000001",
      error: null,
    });
    expect(parseSlackScheduledActOutput('{"ok":false,"error":"too late\\nstack"}')).toEqual({
      ok: false,
      newId: null,
      error: "too late",
    });
    expect(parseSlackScheduledActOutput("").ok).toBe(false);
    expect(parseSlackScheduledActOutput("[]").error).toMatch(/no answer/);
  });
});

describe("SlackScheduledActions (delta 135, 2026-11-23)", () => {
  it("runs the act script with the request on stdin and without the agent markers", async () => {
    const home = homeWithScript(FAKE_SCRIPT);
    const previous = process.env.PASEO_AGENT_ID;
    process.env.PASEO_AGENT_ID = "agent-under-test";
    let settled = 0;
    try {
      const actions = new SlackScheduledActions({
        logger,
        homeDir: home,
        now: () => NOW,
        onSettled: () => (settled += 1),
      });
      expect(
        await actions.run({ action: "change", id: "Q0ABC1234", postAt: LATER_S, text: "비밀 글" }),
      ).toEqual({ ok: true, newId: "QNEW000001", error: null });
      expect(await actions.run({ action: "cancel", id: "Q0ABC1234" })).toEqual({
        ok: true,
        newId: null,
        error: null,
      });
      expect(settled).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = previous;
    }
  });

  it("answers a clear error when the script is missing, and still drops the list cache", async () => {
    let settled = 0;
    const actions = new SlackScheduledActions({
      logger,
      homeDir: mkdtempSync(path.join(tmpdir(), "paseo-slack-act-none-")),
      now: () => NOW,
      onSettled: () => (settled += 1),
    });
    const result = await actions.run({ action: "cancel", id: "Q0ABC1234" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not on this host/);
    expect(settled).toBe(1);
  });

  it("refuses an invalid request before running anything", async () => {
    let runs = 0;
    const actions = new SlackScheduledActions({
      logger,
      now: () => NOW,
      onSettled: () => {},
      fileExists: async () => true,
      runCommand: async () => {
        runs += 1;
        return '{"ok":true}';
      },
    });
    expect((await actions.run({ action: "change", id: "Q0ABC1234" })).ok).toBe(false);
    expect(runs).toBe(0);
  });

  it("runs one action at a time", async () => {
    let release: (stdout: string) => void = () => {};
    const actions = new SlackScheduledActions({
      logger,
      now: () => NOW,
      onSettled: () => {},
      fileExists: async () => true,
      runCommand: (_path, stdin) =>
        stdin.includes("Q0ABC1234")
          ? new Promise<string>((resolve) => (release = resolve))
          : Promise.resolve('{"ok":true}'),
    });
    const first = actions.run({ action: "cancel", id: "Q0ABC1234" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await actions.run({ action: "cancel", id: "Q0XYZ9876" });
    expect(second).toEqual({
      ok: false,
      newId: null,
      error: "Another change to a scheduled message is still running",
    });
    release('{"ok":true}');
    expect((await first).ok).toBe(true);
    expect((await actions.run({ action: "cancel", id: "Q0XYZ9876" })).ok).toBe(true);
  });

  it("turns a script that does not finish into a failure", async () => {
    const actions = new SlackScheduledActions({
      logger,
      now: () => NOW,
      onSettled: () => {},
      fileExists: async () => true,
      runCommand: async () => {
        throw new Error("Command failed: timed out");
      },
    });
    const result = await actions.run({ action: "cancel", id: "Q0ABC1234" });
    expect(result).toEqual({
      ok: false,
      newId: null,
      error: "The Slack script did not finish: Command failed: timed out",
    });
  });
});

describe("schedule.slack.cancel/update handlers (delta 135, 2026-11-23)", () => {
  it("answers with the request id, and an error on a host without the runner", async () => {
    const actions = new SlackScheduledActions({
      logger,
      now: () => NOW,
      onSettled: () => {},
      fileExists: async () => true,
      runCommand: async () => '{"ok":true,"newId":"QNEW000001"}',
    });
    const emitted: SessionOutboundMessage[] = [];
    const emit = (message: SessionOutboundMessage) => emitted.push(message);
    await handleScheduleSlackCancelRequest({
      actions,
      request: { type: "schedule.slack.cancel.request", id: "Q0ABC1234", requestId: "r1" },
      emit,
    });
    await handleScheduleSlackUpdateRequest({
      actions,
      request: {
        type: "schedule.slack.update.request",
        id: "Q0ABC1234",
        postAt: LATER_S,
        requestId: "r2",
      },
      emit,
    });
    await handleScheduleSlackUpdateRequest({
      actions: null,
      request: {
        type: "schedule.slack.update.request",
        id: "Q0ABC1234",
        text: "x",
        requestId: "r3",
      },
      emit,
    });
    expect(emitted).toEqual([
      {
        type: "schedule.slack.cancel.response",
        payload: { requestId: "r1", ok: true, error: null },
      },
      {
        type: "schedule.slack.update.response",
        payload: { requestId: "r2", ok: true, newId: "QNEW000001", error: null },
      },
      {
        type: "schedule.slack.update.response",
        payload: {
          requestId: "r3",
          ok: false,
          newId: null,
          error: "Changing scheduled Slack messages is not available on this host",
        },
      },
    ]);
  });
});
