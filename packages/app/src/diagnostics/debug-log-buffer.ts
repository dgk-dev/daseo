// Daseo delta 68: every console line the app writes, kept in memory so the Mac can pull it with
// `phone_logs` (client.debug.collect.request). Release builds send console output only to the
// native log, which used to need wireless ADB.

export interface DebugLogEntry {
  at: number;
  level: string;
  message: string;
}

const MAX_ENTRIES = 2000;
const MESSAGE_LIMIT = 2000;
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

const entries: DebugLogEntry[] = [];
let installed = false;

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error)
    return value.stack ? `${value.message}\n${value.stack}` : value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function recordDebugLog(level: string, args: readonly unknown[]): void {
  let message = args.map(format).join(" ");
  if (message.length > MESSAGE_LIMIT) message = `${message.slice(0, MESSAGE_LIMIT)}…`;
  entries.push({ at: Date.now(), level, message });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Wraps every console level once; the original console still runs first. */
export function installDebugLogBuffer(): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        recordDebugLog(level, args);
      } catch {
        // Never let the buffer break logging.
      }
    };
  }
}

export function readDebugLog(maxEntries: number): DebugLogEntry[] {
  return maxEntries <= 0 ? [] : entries.slice(-maxEntries);
}

export function resetDebugLogForTests(): void {
  entries.length = 0;
}
