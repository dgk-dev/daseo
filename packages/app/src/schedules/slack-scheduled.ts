import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SlackScheduledEntry } from "@getpaseo/protocol/messages";
import { toErrorMessage } from "@/utils/error-messages";

/**
 * Daseo delta 135: the Schedules screen's Slack filter. The daemon reads pi-local's record of the
 * Slack messages agents scheduled (`slack_post postAt`); this module merges the hosts that
 * advertise `slackScheduledList`, splits the list into upcoming and past, and owns the labels the
 * rows show. The owner's cancel and change buttons (2026-11-23) go through `useSlackScheduled`.
 */

export const slackScheduledQueryBaseKey = ["schedules", "slack"] as const;

export const SLACK_SCHEDULED_REFRESH_MS = 60_000;
export const SLACK_SCHEDULED_PAST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface SlackScheduledHostInput {
  serverId: string;
  serverName: string;
}

export interface SlackScheduledRuntime {
  getClient(serverId: string): Pick<DaemonClient, "listSlackScheduled"> | null;
  isOnline(serverId: string): boolean;
}

/** What one of the owner's buttons did: a change comes back under a new id. */
export type SlackScheduledActionResult =
  | { ok: true; newId: string | null }
  | { ok: false; error: string };

export interface SlackScheduledChange {
  postAt?: number;
  text?: string;
}

/** The whole message as the daemon sent it; an older daemon sends only the first line. */
export function slackEntryText(entry: SlackScheduledEntry): string {
  // COMPAT(slackScheduledText): added in v0.5.155, remove after 2027-05-23 once daemon floor >= v0.5.155.
  return entry.text ?? entry.firstLine;
}

export interface AggregatedSlackScheduled extends SlackScheduledEntry {
  serverId: string;
  serverName: string;
}

export interface SlackScheduledHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface SlackScheduledFetchResult {
  entries: AggregatedSlackScheduled[];
  hostErrors: SlackScheduledHostError[];
  /** A host could not check Slack and showed its record as written. */
  warnings: string[];
}

/**
 * Ask every online host that supports the feature and merge their lists. Two hosts reading the
 * same Mac's record return the same ids; each id is kept once. Throws only when every asked host
 * failed, so the list shows an error instead of an empty state that is not true.
 */
export async function fetchSlackScheduled(input: {
  hosts: readonly SlackScheduledHostInput[];
  runtime: SlackScheduledRuntime;
}): Promise<SlackScheduledFetchResult> {
  const byId = new Map<string, AggregatedSlackScheduled>();
  const hostErrors: SlackScheduledHostError[] = [];
  const warnings: string[] = [];
  let asked = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const client = input.runtime.getClient(host.serverId);
      if (!client || !input.runtime.isOnline(host.serverId)) return;
      asked += 1;
      try {
        const payload = await client.listSlackScheduled();
        if (payload.error) throw new Error(payload.error);
        if (payload.warning) warnings.push(payload.warning);
        for (const entry of payload.entries) {
          if (!byId.has(entry.id)) {
            byId.set(entry.id, { ...entry, serverId: host.serverId, serverName: host.serverName });
          }
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (asked > 0 && hostErrors.length === asked) {
    throw new Error("Could not load scheduled Slack messages");
  }
  return { entries: [...byId.values()], hostErrors, warnings };
}

export interface SlackScheduledSections<T extends SlackScheduledEntry> {
  /** Still waiting to be sent, soonest first. */
  upcoming: T[];
  /** Sent, cancelled, failed, replaced, or not yet confirmed; newest first, last 30 days. */
  past: T[];
}

export function partitionSlackScheduled<T extends SlackScheduledEntry>(
  entries: readonly T[],
  now: number,
): SlackScheduledSections<T> {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const entry of entries) {
    if (entry.status === "scheduled") {
      upcoming.push(entry);
    } else if (now - entry.postAt * 1000 <= SLACK_SCHEDULED_PAST_WINDOW_MS) {
      past.push(entry);
    }
  }
  upcoming.sort((a, b) => a.postAt - b.postAt);
  past.sort((a, b) => b.postAt - a.postAt);
  return { upcoming, past };
}

export type SlackStatusBadgeVariant = "success" | "error" | "muted";

/** Same colour meanings as the schedule rows: success = still going to run, error = failed. */
export function slackStatusBadge(status: string): {
  label: string;
  variant: SlackStatusBadgeVariant;
} {
  switch (status) {
    case "scheduled":
      return { label: "예정", variant: "success" };
    case "sent":
      return { label: "발송됨", variant: "muted" };
    case "cancelled":
      return { label: "취소됨", variant: "muted" };
    case "failed":
      return { label: "실패", variant: "error" };
    case "replaced":
      return { label: "바뀜", variant: "muted" };
    default:
      return { label: "확인 전", variant: "muted" };
  }
}

export function slackSenderLabel(as: string): string {
  return as === "bot" ? "알림봇" : "본인";
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The post time in Korea time ("11/20 08:00"), whatever the device's zone. Computed from a fixed
 * +9 h offset (Korea has no daylight saving time) so Hermes builds without full time-zone data
 * print the same text.
 */
export function formatSlackPostTime(postAtSeconds: number): string {
  const kst = new Date(postAtSeconds * 1000 + KST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/**
 * What pressing a sent row opens: the Slack app link first (when the daemon sent one), the https
 * permalink as the fallback. Null when the row opens nothing (not sent, or no permalink).
 */
export function slackEntryLink(
  entry: SlackScheduledEntry,
): { appLink: string | null; permalink: string } | null {
  if (entry.status !== "sent" || !entry.permalink) {
    return null;
  }
  return { appLink: entry.appLink ?? null, permalink: entry.permalink };
}
