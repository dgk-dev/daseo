import { Platform } from "react-native";
import type { ClientDiagnosticsEvent } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveAppVersion } from "@/utils/app-version";

// Daseo delta 61. Errors the app shows or logs are handed to a connected daemon that
// advertises `clientDiagnostics`, so a phone problem can be read in daemon.log on the Mac.
// Everything here is best effort: nothing it does may itself surface an error.

const MAX_PENDING = 200;
const MAX_PER_MINUTE = 40;
const DEDUPE_WINDOW_MS = 60_000;
const FLUSH_DELAY_MS = 1_500;
const RETRY_DELAY_MS = 30_000;
const REPORT_BATCH = 50;
const MESSAGE_LIMIT = 2_000;
const DETAIL_LIMIT = 4_000;

interface PendingEvent extends ClientDiagnosticsEvent {
  key: string;
}

export interface ClientDiagnosticInput {
  level: "error" | "warn";
  scope: string;
  message: string;
  detail?: string;
}

const pending: PendingEvent[] = [];
let recordedThisMinute = 0;
let minuteStartedAt = 0;
let droppedThisMinute = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let installed = false;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function formatArgument(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ? `${value.message}\n${value.stack}` : value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function recordClientDiagnostic(input: ClientDiagnosticInput): void {
  const message = truncate(input.message.trim(), MESSAGE_LIMIT);
  if (!message) {
    return;
  }
  const now = Date.now();
  if (now - minuteStartedAt >= 60_000) {
    if (droppedThisMinute > 0) {
      pending.push({
        key: "",
        at: now,
        level: "warn",
        scope: "diagnostics",
        message: `${droppedThisMinute} more events were not recorded in the last minute`,
      });
    }
    minuteStartedAt = now;
    recordedThisMinute = 0;
    droppedThisMinute = 0;
  }
  const key = `${input.level}|${input.scope}|${message}`;
  const existing = pending.find((event) => event.key === key && now - event.at < DEDUPE_WINDOW_MS);
  if (existing) {
    existing.count = (existing.count ?? 1) + 1;
    scheduleFlush();
    return;
  }
  if (recordedThisMinute >= MAX_PER_MINUTE) {
    droppedThisMinute += 1;
    return;
  }
  recordedThisMinute += 1;
  pending.push({
    key,
    at: now,
    level: input.level,
    scope: truncate(input.scope, 64),
    message,
    ...(input.detail ? { detail: truncate(input.detail, DETAIL_LIMIT) } : {}),
  });
  while (pending.length > MAX_PENDING) {
    pending.shift();
  }
  scheduleFlush();
}

function scheduleFlush(delayMs = FLUSH_DELAY_MS): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushClientDiagnostics();
  }, delayMs);
}

function pickReportingServerId(): string | null {
  const sessions = useSessionStore.getState().sessions;
  const runtime = getHostRuntimeStore();
  for (const [serverId, session] of Object.entries(sessions)) {
    if (session.serverInfo?.features?.clientDiagnostics !== true) {
      continue;
    }
    if (!runtime.getClient(serverId)) {
      continue;
    }
    return serverId;
  }
  return null;
}

export async function flushClientDiagnostics(): Promise<void> {
  if (flushing || pending.length === 0) {
    return;
  }
  const serverId = pickReportingServerId();
  const client = serverId ? getHostRuntimeStore().getClient(serverId) : null;
  if (!client) {
    scheduleFlush(RETRY_DELAY_MS);
    return;
  }
  flushing = true;
  const batch = pending.splice(0, REPORT_BATCH);
  try {
    await client.reportClientDiagnostics({
      platform: Platform.OS,
      appVersion: resolveAppVersion() ?? undefined,
      events: batch.map(({ key: _key, ...event }) => event),
    });
    if (pending.length > 0) {
      scheduleFlush(0);
    }
  } catch {
    // The daemon was not reachable; keep the batch for the next try.
    pending.unshift(...batch);
    while (pending.length > MAX_PENDING) {
      pending.shift();
    }
    scheduleFlush(RETRY_DELAY_MS);
  } finally {
    flushing = false;
  }
}

/** Reads of the pending queue for tests. */
export function peekPendingClientDiagnostics(): readonly ClientDiagnosticsEvent[] {
  return pending.map(({ key: _key, ...event }) => event);
}

export function resetClientDiagnosticsForTests(): void {
  pending.length = 0;
  recordedThisMinute = 0;
  minuteStartedAt = 0;
  droppedThisMinute = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = false;
}

const UNHANDLED_REJECTION_PREFIX = "Possible Unhandled Promise Rejection";

/** Hooks console errors, unhandled rejections, and fatal JS errors. Safe to call more than once. */
export function installClientDiagnostics(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    try {
      const [first, ...rest] = args;
      const message = formatArgument(first);
      const detail = rest.map(formatArgument).join("\n");
      recordClientDiagnostic({
        level: "error",
        scope: "console",
        message,
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Never let reporting break the thing being reported.
    }
  };

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    try {
      const message = formatArgument(args[0]);
      if (message.startsWith(UNHANDLED_REJECTION_PREFIX)) {
        recordClientDiagnostic({
          level: "warn",
          scope: "promise",
          message,
          detail: args.slice(1).map(formatArgument).join("\n") || undefined,
        });
      }
    } catch {
      // See above.
    }
  };

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (errorUtils && typeof errorUtils.setGlobalHandler === "function") {
    const previous = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal) => {
      try {
        recordClientDiagnostic({
          level: "error",
          scope: isFatal ? "fatal" : "uncaught",
          message: formatArgument(error),
        });
        void flushClientDiagnostics();
      } catch {
        // See above.
      }
      previous?.(error, isFatal);
    });
  }
}

interface ErrorUtilsLike {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}
