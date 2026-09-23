/**
 * Presentation model for a Paseo system prompt row (`origin: "system"`). The daemon
 * wraps subagent notifications and schedule fires in `<paseo-system>`; the first
 * line of the body says what triggered the turn, the rest is detail.
 */

type AgentNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

export type SystemNotificationSummary =
  | { kind: "agent"; title: string; reason: AgentNotificationReason }
  | { kind: "schedule"; name: string | null }
  | { kind: "text"; text: string };

export interface SystemNotification {
  summary: SystemNotificationSummary;
  /** Envelope content without the `<paseo-system>` wrapper. */
  body: string;
}

const ENVELOPE_PATTERN = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/;
const AGENT_STATUS_PATTERN =
  /^Agent (\S+) \((.*)\) (finished|errored|needs permission|was closed)\.$/;
const NAMED_SCHEDULE_PATTERN = /^Schedule "(.*)" fired \(id=[^)]*\)\.$/;
const SCHEDULE_PATTERN = /^Schedule fired \(id=[^)]*\)\.$/;

function summarize(firstLine: string): SystemNotificationSummary {
  const agent = AGENT_STATUS_PATTERN.exec(firstLine);
  if (agent) {
    const [, agentId, title, reason] = agent;
    const trimmedTitle = title?.trim();
    return {
      kind: "agent",
      title: trimmedTitle && trimmedTitle !== agentId ? trimmedTitle : agentId!,
      reason: reason as AgentNotificationReason,
    };
  }
  const namedSchedule = NAMED_SCHEDULE_PATTERN.exec(firstLine);
  if (namedSchedule) {
    return { kind: "schedule", name: namedSchedule[1] ?? null };
  }
  if (SCHEDULE_PATTERN.test(firstLine)) {
    return { kind: "schedule", name: null };
  }
  return { kind: "text", text: firstLine };
}

export function parseSystemNotification(text: string): SystemNotification {
  const body = ENVELOPE_PATTERN.exec(text)?.[1] ?? text;
  const firstLine =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return { summary: summarize(firstLine), body: body.trim() };
}

const AGENT_REASON_KEYS = {
  finished: "message.systemNotification.agentFinished",
  errored: "message.systemNotification.agentErrored",
  "needs permission": "message.systemNotification.agentNeedsPermission",
  "was closed": "message.systemNotification.agentClosed",
} as const satisfies Record<AgentNotificationReason, string>;

type Translate = (key: string, values?: Record<string, string>) => string;

export function formatSystemNotificationLabel(
  summary: SystemNotificationSummary,
  t: Translate,
): string {
  switch (summary.kind) {
    case "agent":
      return t(AGENT_REASON_KEYS[summary.reason], { title: summary.title });
    case "schedule":
      return summary.name
        ? t("message.systemNotification.scheduleNamed", { name: summary.name })
        : t("message.systemNotification.schedule");
    case "text":
      return summary.text;
  }
}
