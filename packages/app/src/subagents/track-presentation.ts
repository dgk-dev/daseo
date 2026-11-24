import { isAgentWaitingInBackground } from "@getpaseo/protocol/agent-state-bucket";
import { BRAILLE_SPINNER_STATIC } from "@/components/braille-spinner/frames";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";
import { isFinishedSubagent } from "./archive-finished";
import { providerSubagentLifecycleStatus } from "./provider-store";

function presentationStatus(row: SubagentRow) {
  if (row.kind === "paseo") return row.status;
  return providerSubagentLifecycleStatus(row.status);
}

export interface SubagentRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildSubagentRowPresentationData(row: SubagentRow): SubagentRowPresentationData {
  // The task distinguishes siblings in a fan-out, so it names the row when present. Providers
  // own the compact secondary context because model, effort, and usage semantics differ.
  const description = resolveRowLabel(row.description);
  const title = resolveRowLabel(row.title);
  const label = description ?? title;
  const providerSubtitle = row.kind === "provider" ? resolveRowLabel(row.subtitle) : null;
  const subtitle = providerSubtitle ?? (description ? title : null);
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: subtitle ?? "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status,
      requiresAttention: false,
      backgroundWaits: row.kind === "paseo" ? row.backgroundWaits : null,
    }),
  };
}

/**
 * Daseo: the track reads like `docker compose` (sketch option C). A row is in exactly one state;
 * the glyph, the state word and their colour all come from it.
 */
export type SubagentRowState = "running" | "waiting" | "done" | "error" | "canceled";

export function resolveSubagentRowState(row: SubagentRow): SubagentRowState {
  if (row.kind === "provider") {
    if (row.status === "running") return "running";
    if (row.status === "failed") return "error";
    if (row.status === "canceled") return "canceled";
    return "done";
  }
  // Blocked on the user outranks everything else, the same order the sidebar uses.
  if (row.needsInput) return "waiting";
  if (row.status === "error") return "error";
  if (
    row.status === "running" ||
    row.status === "initializing" ||
    isSubagentWaitingInBackground(row)
  ) {
    return "running";
  }
  return "done";
}

export const SUBAGENT_STATE_WORD: Record<SubagentRowState, string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  error: "Error",
  canceled: "Canceled",
};

/** The static glyph of a state; a running row shows the braille spinner instead. */
export const SUBAGENT_STATE_GLYPH: Record<SubagentRowState, string> = {
  running: BRAILLE_SPINNER_STATIC,
  waiting: "?",
  done: "✔",
  error: "✘",
  canceled: "-",
};

/** A row's time: live since it was created while it works, then the total up to its end. */
export function resolveSubagentRowDurationMs(row: SubagentRow, nowMs: number): number | null {
  const startedMs = row.createdAt.getTime();
  if (!Number.isFinite(startedMs)) return null;
  const state = resolveSubagentRowState(row);
  if (state === "running" || state === "waiting") {
    return Math.max(0, nowMs - startedMs);
  }
  const endedMs = row.endedAt?.getTime();
  if (endedMs === undefined || !Number.isFinite(endedMs) || endedMs < startedMs) return null;
  return endedMs - startedMs;
}

export interface SubagentTrackSummary {
  total: number;
  /** Running or waiting in the background: what `Running N/M` counts. */
  running: number;
  waiting: number;
  failed: number;
  /** When the oldest running row started; the header's elapsed time counts from it. */
  oldestRunningStartedAt: number | null;
}

export function summarizeSubagentTrack(rows: readonly SubagentRow[]): SubagentTrackSummary {
  const summary: SubagentTrackSummary = {
    total: rows.length,
    running: 0,
    waiting: 0,
    failed: 0,
    oldestRunningStartedAt: null,
  };
  for (const row of rows) {
    const state = resolveSubagentRowState(row);
    if (state === "running") {
      summary.running += 1;
      const startedAt = row.createdAt.getTime();
      if (
        Number.isFinite(startedAt) &&
        (summary.oldestRunningStartedAt === null || startedAt < summary.oldestRunningStartedAt)
      ) {
        summary.oldestRunningStartedAt = startedAt;
      }
    } else if (state === "waiting") {
      summary.waiting += 1;
    } else if (state === "error") {
      summary.failed += 1;
    }
  }
  return summary;
}

/** `spinner` is the bracketed braille spinner (`[⠹]`); its text is the static form. */
export type TrackHeaderTone = "spinner" | "prompt" | "strong" | "muted" | "warning" | "destructive";

export interface TrackHeaderSegment {
  text: string;
  tone: TrackHeaderTone;
}

/**
 * The header as coloured pieces. While anything runs: `[⠹] Running 1/3  2min 13s`, the spinner
 * between the brackets. Otherwise a muted `[+] 3 subagents · done`, with rows that wait on the
 * user or failed counted after it.
 */
export function buildTrackHeader(
  summary: SubagentTrackSummary,
  elapsedLabel: string | null,
): TrackHeaderSegment[] {
  if (summary.running > 0) {
    const segments: TrackHeaderSegment[] = [
      { text: `[${BRAILLE_SPINNER_STATIC}]`, tone: "spinner" },
      { text: ` Running ${summary.running}/${summary.total}`, tone: "strong" },
    ];
    if (elapsedLabel) {
      segments.push({ text: `  ${elapsedLabel}`, tone: "muted" });
    }
    return segments;
  }
  const noun = summary.total === 1 ? "subagent" : "subagents";
  const segments: TrackHeaderSegment[] = [{ text: `[+] ${summary.total} ${noun}`, tone: "muted" }];
  if (summary.waiting > 0) {
    segments.push({ text: ` · ${summary.waiting} waiting`, tone: "warning" });
  } else {
    segments.push({ text: " · done", tone: "muted" });
  }
  if (summary.failed > 0) {
    segments.push({ text: ` · ${summary.failed} failed`, tone: "destructive" });
  }
  return segments;
}

/** The header as plain text for its accessible name; the moving spinner is left out. */
export function formatTrackHeaderText(segments: readonly TrackHeaderSegment[]): string {
  return segments
    .filter((segment) => segment.tone !== "spinner")
    .map((segment) => segment.text)
    .join("")
    .trimStart();
}

function isSubagentWaitingInBackground(row: SubagentRow): boolean {
  return (
    row.kind === "paseo" &&
    isAgentWaitingInBackground({ status: row.status, backgroundWaits: row.backgroundWaits })
  );
}

export function countFinishedSubagents(rows: readonly SubagentRow[]): number {
  return rows.filter(isFinishedSubagent).length;
}

export function resolveRowLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}
