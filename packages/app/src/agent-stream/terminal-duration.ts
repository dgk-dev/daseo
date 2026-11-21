/**
 * Daseo: durations in the terminal chrome (tool rows, the subagents track): `13s`, `41.2s`,
 * `2min 13s`, `1min 05s`, `1h 02min`. Seconds and minutes after a larger unit are two digits
 * so a column of them lines up in a monospace font.
 */
export function formatTerminalDuration(durationMs: number, options?: { tenths?: boolean }): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  if (options?.tenths && durationMs < 60_000) {
    // Truncated, not rounded: 59.96 s must not read as 60.0s.
    return `${(Math.floor(durationMs / 100) / 10).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const two = (value: number) => String(value).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}min ${two(totalSeconds % 60)}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${two(totalMinutes % 60)}min`;
}

/**
 * How long a tool call ran, from the stream's own timestamps: the first time this app saw the
 * call running (delta 73) to the timestamp of the update that ended it. A call that was already
 * finished when it arrived (history) has no such pair and gets no duration.
 */
export class ToolRunClock {
  private readonly runningSince = new Map<string, number>();
  private readonly ranFor = new Map<string, number>();

  constructor(private readonly finishedLimit = 2000) {}

  observe(input: { itemId: string; running: boolean; seenAt: Date; now?: number }): {
    startedAt?: number;
    ranForMs?: number;
  } {
    const seenAtMs = input.seenAt.getTime();
    if (input.running) {
      let since = this.runningSince.get(input.itemId);
      if (since === undefined) {
        since = Math.min(seenAtMs, input.now ?? Date.now());
        this.runningSince.set(input.itemId, since);
        // A call that runs again starts a new measurement.
        this.ranFor.delete(input.itemId);
      }
      return { startedAt: since };
    }
    const since = this.runningSince.get(input.itemId);
    if (since !== undefined) {
      this.runningSince.delete(input.itemId);
      if (Number.isFinite(seenAtMs) && seenAtMs >= since) {
        this.ranFor.set(input.itemId, seenAtMs - since);
        if (this.ranFor.size > this.finishedLimit) {
          const oldest = this.ranFor.keys().next().value;
          if (oldest !== undefined) this.ranFor.delete(oldest);
        }
      }
    }
    const ranForMs = this.ranFor.get(input.itemId);
    return ranForMs === undefined ? {} : { ranForMs };
  }
}

/**
 * The exit code a finished shell row shows. Only the provider's own number counts: a missing or
 * null code shows nothing, and success is never read as `exit 0`.
 */
export function resolveToolRowExitCode(input: {
  detail: { type: string; exitCode?: number | null } | undefined;
  running: boolean;
}): number | null {
  if (input.running || input.detail?.type !== "shell") return null;
  const code = input.detail.exitCode;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

export interface ToolRowInfo {
  durationLabel?: string;
  /** The exit code the provider reported for a finished shell command; absent shows nothing. */
  exitCode?: number;
}

/**
 * The finished row's trailing column: the exit code a shell command reported, then how long the
 * call took. The tool's own reported duration wins (search, fetch); otherwise the time this
 * screen measured from the stream. Neither known means nothing is shown.
 */
export function buildToolRowInfo(input: {
  reportedDurationMs: number | null;
  ranForMs: number | undefined;
  exitCode: number | null;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
}): ToolRowInfo {
  const finished = input.status !== "running" && input.status !== "executing";
  let durationMs: number | undefined;
  if (finished) {
    durationMs =
      input.reportedDurationMs !== null && input.status === "completed"
        ? input.reportedDurationMs
        : input.ranForMs;
  }
  return {
    ...(durationMs === undefined
      ? {}
      : { durationLabel: formatTerminalDuration(durationMs, { tenths: true }) }),
    ...(input.exitCode === null ? {} : { exitCode: input.exitCode }),
  };
}
