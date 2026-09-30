/**
 * Presentation model for a Paseo system prompt row (`origin: "system"`). The daemon
 * wraps subagent notifications and schedule fires in `<paseo-system>`; the first
 * line of the body says what triggered the turn, the rest is detail. pi-local's
 * `wait_for` wakes (Daseo delta 30) use the same envelope with machine lines first:
 * `wait_for: <kind> <wait_id> <fired|exited|timed_out> pending=<N>`.
 */

type AgentNotificationReason = "finished" | "errored" | "needs permission" | "was closed";
export type WaitNotificationOutcome = "fired" | "exited" | "timed_out";

export type SystemNotificationSummary =
  | { kind: "agent"; title: string; reason: AgentNotificationReason }
  | { kind: "schedule"; name: string | null }
  | {
      kind: "wait";
      description: string;
      outcome: WaitNotificationOutcome;
      exitCode: number | null;
    }
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
const WAIT_HEADER_PATTERN = /^wait_for: \S+ (\S+) (fired|exited|timed_out) pending=\d+$/;
const WAIT_EVENT_PATTERN = /^Wait event\((.*?)\): /;
const WAIT_EXIT_CODE_PATTERN = /exited with code (-?\d+)/;

function summarizeWait(
  header: RegExpExecArray,
  lines: readonly string[],
): SystemNotificationSummary {
  const [, waitId, outcome] = header;
  let description: string | null = null;
  let exitCode: number | null = null;
  for (const line of lines) {
    const event = WAIT_EVENT_PATTERN.exec(line);
    if (!event) continue;
    description ??= event[1]!.trim();
    const code = WAIT_EXIT_CODE_PATTERN.exec(line.slice(event[0].length));
    if (code) {
      exitCode = Number(code[1]);
      break;
    }
    if (outcome !== "exited") break;
  }
  return {
    kind: "wait",
    description: description || waitId!,
    outcome: outcome as WaitNotificationOutcome,
    exitCode: outcome === "exited" ? exitCode : null,
  };
}

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
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  const waitHeader = WAIT_HEADER_PATTERN.exec(firstLine);
  const summary = waitHeader ? summarizeWait(waitHeader, lines) : summarize(firstLine);
  return { summary, body: body.trim() };
}

/** True for a `wait_for` wake envelope: a background wait reporting back, not a new request. */
export function isWaitWakeNotificationText(text: string): boolean {
  const body = ENVELOPE_PATTERN.exec(text)?.[1];
  if (body === undefined) return false;
  const newline = body.indexOf("\n");
  return WAIT_HEADER_PATTERN.test((newline === -1 ? body : body.slice(0, newline)).trim());
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
    case "wait":
      return t("message.systemNotification.waitDone", {
        description: summary.description,
        outcome: formatWaitOutcome(summary, t),
      });
    case "text":
      return summary.text;
  }
}

function formatWaitOutcome(
  summary: Extract<SystemNotificationSummary, { kind: "wait" }>,
  t: Translate,
): string {
  switch (summary.outcome) {
    case "exited":
      return summary.exitCode === null
        ? t("message.systemNotification.waitOutcomeExitedWithoutCode")
        : t("message.systemNotification.waitOutcomeExited", { code: String(summary.exitCode) });
    case "fired":
      return t("message.systemNotification.waitOutcomeFired");
    case "timed_out":
      return t("message.systemNotification.waitOutcomeTimedOut");
  }
}
