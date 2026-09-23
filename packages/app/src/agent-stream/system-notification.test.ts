import { describe, expect, it } from "vitest";
import { formatSystemNotificationLabel, parseSystemNotification } from "./system-notification";

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
