import { describe, expect, it } from "vitest";
import {
  formatSystemNotificationLabel,
  isWaitWakeNotificationText,
  parseSystemNotification,
} from "./system-notification";

const t = (key: string, values?: Record<string, string>) =>
  `${key}${values ? ` ${JSON.stringify(values)}` : ""}`;

function envelope(body: string): string {
  return `<paseo-system>\n${body}\n</paseo-system>`;
}

describe("parseSystemNotification", () => {
  it("names a finished subagent by title and drops its raw id", () => {
    const notification = parseSystemNotification(
      envelope(
        "Agent 8f3c2a1b (Implement boundary rows) finished.\n<agent-response>\nDone.\n</agent-response>",
      ),
    );

    expect(notification.summary).toEqual({
      kind: "agent",
      title: "Implement boundary rows",
      reason: "finished",
    });
    expect(notification.body).toBe(
      "Agent 8f3c2a1b (Implement boundary rows) finished.\n<agent-response>\nDone.\n</agent-response>",
    );
    expect(formatSystemNotificationLabel(notification.summary, t)).toBe(
      'message.systemNotification.agentFinished {"title":"Implement boundary rows"}',
    );
  });

  it("falls back to the id when the subagent has no title of its own", () => {
    const { summary } = parseSystemNotification(
      envelope("Agent 8f3c2a1b (8f3c2a1b) needs permission."),
    );

    expect(summary).toEqual({ kind: "agent", title: "8f3c2a1b", reason: "needs permission" });
    expect(formatSystemNotificationLabel(summary, t)).toBe(
      'message.systemNotification.agentNeedsPermission {"title":"8f3c2a1b"}',
    );
  });

  it("labels schedule fires without their ids", () => {
    const named = parseSystemNotification(
      envelope('Schedule "Nightly audit" fired (id=abc, run=r1).\nRun the audit.'),
    );
    const unnamed = parseSystemNotification(envelope("Schedule fired (id=abc, run=r1).\nRun it."));

    expect(formatSystemNotificationLabel(named.summary, t)).toBe(
      'message.systemNotification.scheduleNamed {"name":"Nightly audit"}',
    );
    expect(formatSystemNotificationLabel(unnamed.summary, t)).toBe(
      "message.systemNotification.schedule",
    );
  });

  it("uses the first non-empty line for any other system prompt", () => {
    const { summary } = parseSystemNotification(envelope("\n  Something else happened.  \nDetail"));

    expect(formatSystemNotificationLabel(summary, t)).toBe("Something else happened.");
  });
});

const WAKE_FOOTER =
  "This is the result of a wait you registered with wait_for, not a new request; continue your task with it.";

describe("wait_for wake notifications", () => {
  it("summarizes an exited command wait with its description and exit code", () => {
    const text = envelope(
      `wait_for: command w_1a2b3c exited pending=0\nWait event(web build): exited with code 2\nFinal output:\nerror TS2322\n${WAKE_FOOTER}`,
    );
    const { summary, body } = parseSystemNotification(text);

    expect(summary).toEqual({
      kind: "wait",
      description: "web build",
      outcome: "exited",
      exitCode: 2,
    });
    expect(body.startsWith("wait_for: command w_1a2b3c exited pending=0")).toBe(true);
    expect(formatSystemNotificationLabel(summary, t)).toBe(
      'message.systemNotification.waitDone {"description":"web build","outcome":"message.systemNotification.waitOutcomeExited {\\"code\\":\\"2\\"}"}',
    );
    expect(isWaitWakeNotificationText(text)).toBe(true);
  });

  it("finds the exit code after line events of the same wake", () => {
    const { summary } = parseSystemNotification(
      envelope(
        "wait_for: command w_1 exited pending=1\nWait event(deploy (prod)): READY\nWait event(deploy (prod)): exited with code 0\nFinal output:\nok",
      ),
    );

    expect(summary).toEqual({
      kind: "wait",
      description: "deploy (prod)",
      outcome: "exited",
      exitCode: 0,
    });
  });

  it("labels matched lines, timeouts, and signal exits without a code", () => {
    const fired = parseSystemNotification(
      envelope("wait_for: file w_f fired pending=0\nWait event(report): file created: /tmp/r.json"),
    ).summary;
    const timedOut = parseSystemNotification(
      envelope(
        "wait_for: command w_t timed_out pending=0\nWait event(ci): timed out after 300s; process group killed",
      ),
    ).summary;
    const killed = parseSystemNotification(
      envelope(
        "wait_for: command w_k exited pending=0\nWait event(server): killed by signal SIGTERM",
      ),
    ).summary;

    expect(fired).toEqual({
      kind: "wait",
      description: "report",
      outcome: "fired",
      exitCode: null,
    });
    expect(formatSystemNotificationLabel(timedOut, t)).toBe(
      'message.systemNotification.waitDone {"description":"ci","outcome":"message.systemNotification.waitOutcomeTimedOut"}',
    );
    expect(killed).toEqual({
      kind: "wait",
      description: "server",
      outcome: "exited",
      exitCode: null,
    });
    expect(formatSystemNotificationLabel(killed, t)).toContain(
      "message.systemNotification.waitOutcomeExitedWithoutCode",
    );
  });

  it("falls back to the wait id when no event line names the wait", () => {
    const { summary } = parseSystemNotification(envelope("wait_for: command w_9 fired pending=1"));

    expect(summary).toEqual({ kind: "wait", description: "w_9", outcome: "fired", exitCode: null });
  });

  it("recognizes only exact wake envelopes", () => {
    expect(isWaitWakeNotificationText("wait_for: command w_1 exited pending=0")).toBe(false);
    expect(
      isWaitWakeNotificationText(envelope("Agent 8f3c2a1b (Implement) finished.\nDone.")),
    ).toBe(false);
    expect(
      isWaitWakeNotificationText(envelope("wait_for: command w_1 cancelled pending=0\nx")),
    ).toBe(false);
    expect(
      parseSystemNotification(envelope("Agent 8f3c2a1b (Implement) finished.")).summary.kind,
    ).toBe("agent");
  });
});
