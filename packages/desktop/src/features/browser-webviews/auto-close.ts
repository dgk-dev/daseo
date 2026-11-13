import type { BrowserAutoCloseMode } from "../../settings/desktop-settings.js";
import type { BrowserCloseBlockReason } from "./index.js";

/**
 * Daseo delta 98. The app decides which agent-opened tabs nobody looked at are due to close (it
 * owns the workspace layouts and tab provenance); main owns the live state that vetoes a close and
 * the setting that says whether closing is on. These are the shapes the two sides exchange.
 */
export interface BrowserAutoCloseCheck {
  mode: BrowserAutoCloseMode;
  afterHours: number;
  blockers: Record<string, BrowserCloseBlockReason | null>;
  /**
   * E2E seam: `PASEO_BROWSER_AUTO_CLOSE_SWEEP_MS="<sweepMs>[,<archivedGraceMs>]"` shortens the
   * app's ten-minute sweep and the six-hour grace for an archived creator's tabs.
   */
  sweepIntervalMs?: number;
  archivedGraceMs?: number;
}

/** The E2E timing overrides, each only when it is a positive number of milliseconds. */
export function readAutoCloseTimingOverride(value: string | undefined): {
  sweepIntervalMs?: number;
  archivedGraceMs?: number;
} {
  const [sweep, grace] = (value ?? "").split(",").map((part) => Number(part));
  return {
    ...(Number.isFinite(sweep) && sweep > 0 ? { sweepIntervalMs: sweep } : {}),
    ...(Number.isFinite(grace) && grace > 0 ? { archivedGraceMs: grace } : {}),
  };
}

export interface BrowserAutoCloseLogEntry {
  action: "would-close" | "closed";
  browserId: string;
  workspaceId: string;
  reason: "creator-archived" | "creator-idle";
  creatorAgentId: string;
  idleHours: number;
  /** Host name only; the full URL stays out of the log. */
  host: string;
}

const MAX_BROWSER_IDS_PER_CHECK = 500;

/** The browser ids the renderer asks about; null when the input is not a list of ids. */
export function readBrowserIdList(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_BROWSER_IDS_PER_CHECK) {
    return null;
  }
  const ids: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    ids.push(value.trim());
  }
  return ids;
}

/** Entries the renderer reports; malformed ones are dropped rather than logged. */
export function readBrowserAutoCloseLogEntries(input: unknown): BrowserAutoCloseLogEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.slice(0, MAX_BROWSER_IDS_PER_CHECK).flatMap((value): BrowserAutoCloseLogEntry[] => {
    if (typeof value !== "object" || value === null) return [];
    const entry = value as Record<string, unknown>;
    if (
      (entry.action !== "would-close" && entry.action !== "closed") ||
      (entry.reason !== "creator-archived" && entry.reason !== "creator-idle") ||
      typeof entry.browserId !== "string" ||
      typeof entry.workspaceId !== "string" ||
      typeof entry.creatorAgentId !== "string" ||
      typeof entry.idleHours !== "number" ||
      !Number.isFinite(entry.idleHours) ||
      typeof entry.host !== "string"
    ) {
      return [];
    }
    return [
      {
        action: entry.action,
        browserId: entry.browserId,
        workspaceId: entry.workspaceId,
        reason: entry.reason,
        creatorAgentId: entry.creatorAgentId,
        idleHours: Math.max(0, Math.floor(entry.idleHours)),
        host: entry.host.slice(0, 253),
      },
    ];
  });
}
