// Local fork (DASEO.md delta 126): get back from a daemon that is alive but does not answer.
//
// On 2026-11-17 the Mac ran out of swap and the kernel suspended the daemon supervisor and worker
// ("memorystatus: suspending … due to swap exhaustion"). That suspension is a Mach task hold
// (`task_suspend`), not SIGSTOP: `ps` keeps showing `S`, the listen socket still completes TCP
// handshakes, and nothing in the kernel lifts the hold when memory recovers. XNU's `kern_sig.c`
// releases one task hold on every SIGCONT (`task_resume_internal`), so SIGCONT wakes both a
// SIGSTOP and a memorystatus suspension, needs no privilege for our own processes, and does nothing
// to a process that is not held. A daemon that still does not answer after that is terminated and
// replaced. Only processes whose command is a Paseo supervisor or worker are ever signalled.

import { execFile } from "node:child_process";
import http from "node:http";
import treeKill from "tree-kill";

export interface DaemonProcessSnapshot {
  pid: number;
  ppid: number;
  /** `ps` state letters, e.g. `S`, `Ss`, `T` (stopped). */
  state: string;
  command: string;
}

/** Resolves true when the daemon answered within `timeoutMs`. */
export type DaemonProbe = (timeoutMs: number) => Promise<boolean>;

export type DaemonRecoveryLog = (message: string, fields?: Record<string, unknown>) => void;

export interface DaemonRecoveryTimings {
  /** How long the daemon may stay silent after SIGCONT before it is replaced. */
  wakeWindowMs: number;
  probeTimeoutMs: number;
  probeIntervalMs: number;
  /** Time for a graceful SIGTERM shutdown before SIGKILL. */
  terminateGraceMs: number;
  killGraceMs: number;
}

// The wake window must stay well above the daemon's worst ordinary stall. Measured on this Mac on
// 2026-11-17 from ~/.paseo daemon logs since 2026-09-27: event-loop delay max 5.05 s over 12,290
// runtime-metric samples, worker start-up (spawn to ready) max 1.6 s over 69 starts. /api/health is
// answered on the event loop, so 12 s of silence after SIGCONT is not a busy daemon.
export const DEFAULT_DAEMON_RECOVERY_TIMINGS: DaemonRecoveryTimings = {
  wakeWindowMs: 12_000,
  probeTimeoutMs: 3_000,
  probeIntervalMs: 500,
  terminateGraceMs: 6_000,
  killGraceMs: 3_000,
};

export type DaemonRecoveryResult =
  | { outcome: "gone"; pid: number }
  | { outcome: "not_paseo"; pid: number; process: DaemonProcessSnapshot }
  | { outcome: "protected"; pid: number; pids: number[] }
  | { outcome: "responsive"; pids: number[]; woke: boolean }
  | { outcome: "replaced"; pids: number[]; forced: boolean }
  | { outcome: "kill_failed"; pids: number[] };

export interface RecoverUnresponsiveDaemonOptions {
  /** A pid of the daemon: its supervisor (pid lock) or its worker (port holder). */
  pid: number;
  probe: DaemonProbe;
  log: DaemonRecoveryLog;
  /** Pids that must never be signalled (the caller and its own worker). */
  protectedPids?: number[];
  timings?: Partial<DaemonRecoveryTimings>;
}

const PASEO_DAEMON_TITLE = /^Paseo (Daemon|Supervisor)(\s|$)/;
const PASEO_DAEMON_SCRIPT = /(supervisor-entrypoint|daemon-worker)\.(ts|js)(\s|$)/;
const PS_TIMEOUT_MS = 5_000;
const EXIT_POLL_MS = 100;

export function isPaseoDaemonCommand(command: string): boolean {
  const trimmed = command.trim();
  return PASEO_DAEMON_TITLE.test(trimmed) || PASEO_DAEMON_SCRIPT.test(trimmed);
}

function runCommand(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PS_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
      // lsof exits 1 when nothing matches; ps exits 1 for an unknown pid.
      if (error && !stdout) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function parsePsLine(line: string): DaemonProcessSnapshot | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    state: match[3] ?? "",
    command: (match[4] ?? "").trim(),
  };
}

async function listProcesses(): Promise<DaemonProcessSnapshot[]> {
  const stdout = await runCommand("ps", ["-A", "-o", "pid=,ppid=,stat=,command="]);
  if (!stdout) {
    return [];
  }
  return stdout
    .split("\n")
    .map(parsePsLine)
    .filter((entry): entry is DaemonProcessSnapshot => entry !== null);
}

export async function readDaemonProcess(pid: number): Promise<DaemonProcessSnapshot | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const stdout = await runCommand("ps", ["-o", "pid=,ppid=,stat=,command=", "-p", String(pid)]);
  if (!stdout) {
    return null;
  }
  return parsePsLine(stdout.split("\n")[0] ?? "");
}

/** Processes listening on a local TCP port, with their command lines. */
export async function findTcpListenHolders(port: number): Promise<DaemonProcessSnapshot[]> {
  if (!Number.isInteger(port) || port <= 0) {
    return [];
  }
  const stdout = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (!stdout) {
    return [];
  }
  const pids = [...new Set(stdout.split(/\s+/).filter(Boolean).map(Number))].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  const snapshots = await Promise.all(pids.map(readDaemonProcess));
  return snapshots.filter((entry): entry is DaemonProcessSnapshot => entry !== null);
}

export function parseTcpListenPort(listen: string): number | null {
  const match = listen.trim().match(/:(\d+)$/);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Probe `GET /api/health` on a daemon listen address (`host:port` or a unix socket path). A
 * suspended daemon still accepts the TCP connection, so only an HTTP answer counts.
 */
export function createHttpHealthProbe(listen: string): DaemonProbe {
  const trimmed = listen.trim();
  const port = parseTcpListenPort(trimmed);
  const target: http.RequestOptions =
    port === null
      ? { socketPath: trimmed.replace(/^unix:/, "") }
      : {
          host: trimmed.slice(0, trimmed.lastIndexOf(":")).replace(/^\[|\]$/g, "") || "127.0.0.1",
          port,
        };
  return (timeoutMs) =>
    new Promise((resolve) => {
      const request = http.get({ ...target, path: "/api/health", agent: false }, (response) => {
        response.resume();
        request.destroy();
        resolve(response.statusCode === 200);
      });
      // Idle timeout: a suspended daemon accepts the connection and never sends a byte.
      request.setTimeout(timeoutMs, () => request.destroy(new Error("health probe timed out")));
      request.on("error", () => resolve(false));
    });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours: the exit checks below decide the outcome.
  }
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, "SIGKILL", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isPidRunning)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(EXIT_POLL_MS);
  }
  return true;
}

/** The supervisor at the root and its Paseo worker children. */
async function resolveDaemonGroup(target: DaemonProcessSnapshot): Promise<{
  root: DaemonProcessSnapshot;
  members: DaemonProcessSnapshot[];
}> {
  const all = await listProcesses();
  const byPid = new Map(all.map((entry) => [entry.pid, entry]));
  const parent = byPid.get(target.ppid);
  const root = parent && isPaseoDaemonCommand(parent.command) ? parent : target;
  const children = all.filter(
    (entry) => entry.ppid === root.pid && isPaseoDaemonCommand(entry.command),
  );
  return { root, members: [byPid.get(root.pid) ?? root, ...children] };
}

/**
 * Wake a daemon that does not answer, and replace it when waking does not help: SIGCONT the
 * supervisor and worker, probe until `wakeWindowMs`, then SIGTERM, then SIGKILL the whole tree.
 * The caller starts the fresh daemon after a `replaced` result.
 */
export async function recoverUnresponsiveDaemon(
  options: RecoverUnresponsiveDaemonOptions,
): Promise<DaemonRecoveryResult> {
  const timings = { ...DEFAULT_DAEMON_RECOVERY_TIMINGS, ...options.timings };
  const { log, probe } = options;
  const target = await readDaemonProcess(options.pid);
  if (!target) {
    log("Unresponsive daemon recovery: process already gone", { pid: options.pid });
    return { outcome: "gone", pid: options.pid };
  }
  if (!isPaseoDaemonCommand(target.command)) {
    log("Unresponsive daemon recovery: process is not a Paseo daemon; not touching it", {
      pid: target.pid,
      command: target.command,
    });
    return { outcome: "not_paseo", pid: target.pid, process: target };
  }

  const { root, members } = await resolveDaemonGroup(target);
  const pids = members.map((entry) => entry.pid);
  const protectedPids = new Set([process.pid, ...(options.protectedPids ?? [])]);
  if (pids.some((pid) => protectedPids.has(pid))) {
    log("Unresponsive daemon recovery: daemon includes this process; not touching it", {
      pid: target.pid,
      pids,
    });
    return { outcome: "protected", pid: target.pid, pids };
  }

  log("Unresponsive daemon recovery: waking daemon with SIGCONT", {
    processes: members.map(({ pid, ppid, state, command }) => ({ pid, ppid, state, command })),
  });
  for (const pid of pids) {
    signalPid(pid, "SIGCONT");
  }

  const wakeDeadline = Date.now() + timings.wakeWindowMs;
  for (;;) {
    if (!isPidRunning(root.pid)) {
      log("Unresponsive daemon recovery: daemon exited after waking", { pids });
      await waitForExit(pids, timings.killGraceMs);
      return { outcome: "replaced", pids, forced: false };
    }
    const remaining = wakeDeadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    if (await probe(Math.min(timings.probeTimeoutMs, remaining))) {
      log("Unresponsive daemon recovery: daemon answers", { pids });
      return { outcome: "responsive", pids, woke: true };
    }
    await sleep(Math.min(timings.probeIntervalMs, Math.max(0, wakeDeadline - Date.now())));
  }

  log("Unresponsive daemon recovery: daemon still silent; sending SIGTERM", {
    pids,
    silentForMs: timings.wakeWindowMs,
  });
  for (const pid of pids) {
    signalPid(pid, "SIGTERM");
  }
  if (await waitForExit(pids, timings.terminateGraceMs)) {
    log("Unresponsive daemon recovery: daemon stopped", { pids });
    return { outcome: "replaced", pids, forced: false };
  }

  log("Unresponsive daemon recovery: daemon ignored SIGTERM; sending SIGKILL", { pids });
  await killTree(root.pid);
  for (const pid of pids) {
    signalPid(pid, "SIGKILL");
  }
  if (await waitForExit(pids, timings.killGraceMs)) {
    log("Unresponsive daemon recovery: daemon killed", { pids });
    return { outcome: "replaced", pids, forced: true };
  }
  log("Unresponsive daemon recovery: daemon survived SIGKILL", { pids });
  return { outcome: "kill_failed", pids };
}
