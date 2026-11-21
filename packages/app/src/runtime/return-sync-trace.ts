import { isNative } from "@/constants/platform";

/**
 * Daseo delta 140: one info line per step of an open chat's return to the screen, in the console
 * ring that `phone_logs` reads (`grep: "[return-sync]"`). The lines answer, from one read, whether
 * a chat that looked stale lacked data (no subscription, no catch-up, the store's end seq did not
 * move) or lacked drawing (the store moved, the list did not). Ids are shortened; no message text.
 * Native only: the desktop and web apps never suspend.
 */

export type ReturnSyncTraceValue = string | number | boolean | null | undefined;

export const RETURN_SYNC_TRACE_PREFIX = "[return-sync]";

/** How long after a return or a resize the store and the list are read back. */
export const RETURN_SYNC_SETTLE_MS = 3_000;

export function shortTraceId(id: string | null | undefined): string | null {
  return id ? id.slice(0, 8) : null;
}

export function formatReturnSyncTrace(
  event: string,
  fields: Record<string, ReturnSyncTraceValue> = {},
): string {
  const parts = [RETURN_SYNC_TRACE_PREFIX, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${value === null ? "-" : String(value)}`);
  }
  return parts.join(" ");
}

export function traceReturnSync(
  event: string,
  fields: Record<string, ReturnSyncTraceValue> = {},
): void {
  if (!isNative) return;
  console.info(formatReturnSyncTrace(event, fields));
}
