import { fork, spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import { signalProcessTree } from "../src/utils/tree-kill.js";
import {
  createHttpHealthProbe,
  findTcpListenHolders,
  isPaseoDaemonCommand,
  parseTcpListenPort,
  recoverUnresponsiveDaemon,
  type DaemonRecoveryTimings,
} from "../src/server/daemon-recovery.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;
// Delta 126: a worker that crashes before it has run this long is restarted after a growing delay
// instead of at once, so a taken port cannot spin a restart every second (161 restarts in 3 min on
// 2026-11-17). With these delays a crash loop restarts at most 5 times in its first minute, then
// twice a minute.
const DEFAULT_CRASH_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const HEALTHY_RUN_RESETS_BACKOFF_MS = 60_000;
// After this many workers in a row found the listen port taken, look at who holds it.
const LISTEN_IN_USE_FAILURES_BEFORE_HOLDER_CHECK = 3;

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
    }
  | {
      type: "paseo:ready";
      listen: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
    }
  | {
      type: "paseo:listen-in-use";
      listen: string;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
}

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string }) => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  logFile?: SupervisorLogFileOptions;
  /** Delays between crash restarts of a worker that never ran long; the last one repeats. */
  crashRestartDelaysMs?: number[];
  /** Timings for waking or replacing an old Paseo daemon that holds the listen port. */
  portHolderRecoveryTimings?: Partial<DaemonRecoveryTimings>;
}

export interface SupervisorController {
  requestShutdown(reason: string): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  if (type === "paseo:ready") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen };
  }
  if (type === "paseo:listen-in-use") {
    const listen = (msg as { listen?: unknown }).listen;
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    return { type: "paseo:listen-in-use", listen };
  }
  if (type === "paseo:restart") {
    const reason = (msg as { reason?: unknown }).reason;
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
    };
  }
  return null;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

function createSupervisorLogStream(options: SupervisorLogFileOptions | undefined) {
  if (!options) {
    return null;
  }

  mkdirSync(path.dirname(options.path), { recursive: true });
  return createRotatingFileStream(path.basename(options.path), {
    path: path.dirname(options.path),
    size: toRotatingFileStreamSize(options.rotate.maxSize),
    maxFiles: options.rotate.maxFiles,
  });
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let exiting = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  const crashRestartDelaysMs =
    options.crashRestartDelaysMs && options.crashRestartDelaysMs.length > 0
      ? options.crashRestartDelaysMs
      : DEFAULT_CRASH_RESTART_DELAYS_MS;
  let crashRestartCount = 0;
  let listenInUseStreak = 0;
  const logStream = createSupervisorLogStream(options.logFile);

  const writeDurableChunk = (chunk: string | Buffer): void => {
    logStream?.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> =>
    new Promise((resolve) => {
      if (!logStream) {
        resolve();
        return;
      }
      logStream.end(resolve);
    });

  const exitSupervisor = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    Promise.resolve(options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const scheduleForceKill = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child !== currentChild) {
        return;
      }
      writeLifecycleLog("Worker did not exit after SIGTERM; forcing SIGKILL", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      void signalProcessTree(currentChild, "SIGKILL").catch((error) => {
        writeLifecycleLog("Failed to force-kill worker process tree", {
          error: error instanceof Error ? error.message : String(error),
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      });
    }, WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: workerEnv,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;
    let workerReadyAt: number | null = null;
    let listenInUse: string | null = null;
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = { type: "paseo:supervisor-heartbeat" };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        workerReadyAt = Date.now();
        listenInUseStreak = 0;
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        Promise.resolve(options.onWorkerReady?.({ listen: lifecycleMessage.listen })).catch(
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
          },
        );
        return;
      }

      if (lifecycleMessage.type === "paseo:listen-in-use") {
        listenInUse = lifecycleMessage.listen;
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", { reason });
        requestShutdown(reason);
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", { reason });
      requestRestart(reason);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearForceKillTimer();
      if (child === currentChild) {
        child = null;
      }
      const exitDescriptor = describeExit(code, signal);
      writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

      if (shuttingDown) {
        log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
        exitSupervisor(0);
        return;
      }

      const crashed =
        restartOnCrash &&
        ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

      if (restarting) {
        restarting = false;
        log(`Worker exited (${exitDescriptor}). Restarting worker...`);
        spawnWorker();
        return;
      }

      if (crashed) {
        const ranLong =
          workerReadyAt !== null && Date.now() - workerReadyAt >= HEALTHY_RUN_RESETS_BACKOFF_MS;
        if (ranLong) {
          crashRestartCount = 0;
        }
        listenInUseStreak = listenInUse ? listenInUseStreak + 1 : 0;
        const delayMs = ranLong
          ? 0
          : (crashRestartDelaysMs[Math.min(crashRestartCount, crashRestartDelaysMs.length - 1)] ??
            0);
        if (!ranLong) {
          crashRestartCount += 1;
        }
        log(
          delayMs > 0
            ? `Worker crashed (${exitDescriptor}). Restarting worker in ${delayMs} ms...`
            : `Worker crashed (${exitDescriptor}). Restarting worker...`,
        );
        if (listenInUse && listenInUseStreak >= LISTEN_IN_USE_FAILURES_BEFORE_HOLDER_CHECK) {
          scheduleRestartAfterHolderCheck(listenInUse, delayMs);
          return;
        }
        scheduleRestart(delayMs);
        return;
      }

      log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
      exitSupervisor(typeof code === "number" ? code : 1);
    });
  };

  const clearRestartTimer = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const scheduleRestart = (delayMs: number): void => {
    clearRestartTimer();
    if (delayMs <= 0) {
      spawnWorker();
      return;
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!shuttingDown && !child) {
        spawnWorker();
      }
    }, delayMs);
  };

  // Delta 126: find who holds the listen port. An old Paseo daemon is woken (SIGCONT) and, if it
  // still does not answer, replaced; any other process is only named in the log, never signalled.
  const scheduleRestartAfterHolderCheck = (listen: string, delayMs: number): void => {
    const checkThenRestart = async (): Promise<void> => {
      let freed = false;
      try {
        freed = await inspectListenPortHolder(listen);
      } catch (error) {
        writeLifecycleLog("Listen port holder check failed", {
          listen,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (shuttingDown || child) {
        return;
      }
      if (freed) {
        crashRestartCount = 0;
        listenInUseStreak = 0;
      }
      scheduleRestart(freed ? 0 : delayMs);
    };
    void checkThenRestart();
  };

  const inspectListenPortHolder = async (listen: string): Promise<boolean> => {
    const port = parseTcpListenPort(listen);
    if (port === null) {
      log(`Listen address ${listen} is in use; holder lookup covers TCP ports only`);
      return false;
    }
    const holders = await findTcpListenHolders(port);
    if (holders.length === 0) {
      writeLifecycleLog("Listen port in use but no holder found", { listen });
      return false;
    }
    let freed = false;
    for (const holder of holders) {
      const paseo = isPaseoDaemonCommand(holder.command) && holder.pid !== process.pid;
      log(
        `Listen port ${listen} is held by PID ${holder.pid} (${holder.command})` +
          (paseo ? "; checking the old Paseo daemon" : "; not a Paseo daemon, leaving it alone"),
      );
      writeLifecycleLog("Listen port holder", {
        listen,
        holderPid: holder.pid,
        holderCommand: holder.command,
        holderState: holder.state,
        paseoDaemon: paseo,
      });
      if (!paseo) {
        continue;
      }
      const result = await recoverUnresponsiveDaemon({
        pid: holder.pid,
        probe: createHttpHealthProbe(listen),
        protectedPids: [process.pid],
        timings: options.portHolderRecoveryTimings,
        log: (message, fields) => writeLifecycleLog(message, { listen, ...fields }),
      });
      writeLifecycleLog("Listen port holder check result", { listen, ...result });
      if (result.outcome === "replaced" || result.outcome === "gone") {
        freed = true;
      }
    }
    return freed;
  };

  const signalWorker = (signal: NodeJS.Signals, reason: string): void => {
    if (!child) {
      return;
    }
    writeLifecycleLog("Supervisor sending signal to worker", {
      reason,
      signal,
      supervisorPid: process.pid,
      workerPid: child.pid ?? null,
    });
    child.kill(signal);
  };

  const requestRestart = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    if (!child && restartTimer) {
      writeLifecycleLog("Restart requested during crash backoff; restarting now", { reason });
      scheduleRestart(0);
      return;
    }
    if (!child || restarting) {
      return;
    }
    restarting = true;
    writeLifecycleLog("Restart requested", { reason });
    log(`${reason}. Stopping worker for restart...`);
    signalWorker("SIGTERM", reason);
    scheduleForceKill(reason);
  };

  const requestShutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    clearRestartTimer();
    writeLifecycleLog("Supervisor shutdown requested", { reason });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      exitSupervisor(0);
      return;
    }
    signalWorker("SIGTERM", reason);
    scheduleForceKill(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
