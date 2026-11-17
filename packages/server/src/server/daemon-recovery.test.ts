import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  createHttpHealthProbe,
  findTcpListenHolders,
  isPaseoDaemonCommand,
  readDaemonProcess,
  recoverUnresponsiveDaemon,
} from "./daemon-recovery.js";

// Throwaway stand-ins for a supervisor and worker: the same process titles as the real daemon, a
// /api/health endpoint, and no Paseo home. The kernel's swap-exhaustion suspension is not
// reproduced here; `kill -STOP` is the stand-in for it (both are released by SIGCONT).
const FAKE_WORKER = `
process.title = "Paseo Daemon";
const http = require("node:http");
const mode = process.env.FAKE_MODE;
if (mode === "ignore-term") process.on("SIGTERM", () => {});
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
server.listen(Number(process.env.FAKE_PORT), "127.0.0.1", () => {
  process.send?.("ready");
  if (mode === "ignore-term" || mode === "silent") { for (;;) {} }
});
`;

const FAKE_SUPERVISOR = `
process.title = "Paseo Supervisor";
const { fork } = require("node:child_process");
const worker = fork(process.env.FAKE_WORKER_PATH, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
worker.on("message", (m) => process.send?.({ worker: worker.pid, m }));
worker.on("exit", () => process.exit(0));
process.on("SIGTERM", () => { worker.kill("SIGTERM"); });
`;

const FOREIGN_SERVER = `
const net = require("node:net");
const server = net.createServer(() => {});
server.listen(Number(process.env.FAKE_PORT), "127.0.0.1", () => process.send?.("ready"));
`;

const children: ChildProcess[] = [];
const extraPids: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  const pids = [...children.splice(0).map((child) => child.pid ?? 0), ...extraPids.splice(0)];
  for (const pid of pids.filter((value) => value > 0)) {
    try {
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function writeScripts(): Promise<{ worker: string; supervisor: string; foreign: string }> {
  // A long directory name keeps argv long enough for the process title to fit.
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-daemon-recovery-test-fixture-"));
  tempDirs.push(dir);
  const worker = path.join(dir, "fake-worker-with-a-long-name.cjs");
  const supervisor = path.join(dir, "fake-supervisor-with-a-long-name.cjs");
  const foreign = path.join(dir, "foreign-server-with-a-long-name.cjs");
  await writeFile(worker, FAKE_WORKER);
  await writeFile(supervisor, FAKE_SUPERVISOR);
  await writeFile(foreign, FOREIGN_SERVER);
  return { worker, supervisor, foreign };
}

async function startFakeDaemon(mode: "healthy" | "silent" | "ignore-term"): Promise<{
  supervisorPid: number;
  workerPid: number;
  port: number;
}> {
  const scripts = await writeScripts();
  const port = await freePort();
  const supervisor = spawn(process.execPath, [scripts.supervisor], {
    env: {
      ...process.env,
      FAKE_MODE: mode,
      FAKE_PORT: String(port),
      FAKE_WORKER_PATH: scripts.worker,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(supervisor);
  const workerPid = await new Promise<number>((resolve, reject) => {
    supervisor.once("message", (message) => resolve((message as { worker: number }).worker));
    supervisor.once("exit", () => reject(new Error("fake supervisor exited early")));
  });
  extraPids.push(workerPid);
  supervisor.disconnect();
  return { supervisorPid: supervisor.pid ?? 0, workerPid, port };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const quick = {
  wakeWindowMs: 1_500,
  probeTimeoutMs: 500,
  probeIntervalMs: 100,
  terminateGraceMs: 1_000,
  killGraceMs: 2_000,
};

describe.skipIf(isPlatform("win32"))("unresponsive daemon recovery (delta 126)", () => {
  test("recognises daemon processes by title or script", () => {
    expect(isPaseoDaemonCommand("Paseo Daemon")).toBe(true);
    expect(isPaseoDaemonCommand("Paseo Supervisor   ")).toBe(true);
    expect(isPaseoDaemonCommand("node /x/scripts/supervisor-entrypoint.ts --dev")).toBe(true);
    expect(isPaseoDaemonCommand("/usr/bin/python3 -m http.server 6767")).toBe(false);
    expect(isPaseoDaemonCommand("Paseo Helper (Renderer)")).toBe(false);
  });

  test("a daemon stopped with SIGSTOP is woken, not replaced", async () => {
    const daemon = await startFakeDaemon("healthy");
    const probe = createHttpHealthProbe(`127.0.0.1:${daemon.port}`);
    expect(await probe(1_000)).toBe(true);
    process.kill(daemon.workerPid, "SIGSTOP");
    process.kill(daemon.supervisorPid, "SIGSTOP");
    expect((await readDaemonProcess(daemon.workerPid))?.state).toMatch(/^T/);
    expect(await probe(500)).toBe(false);

    const messages: string[] = [];
    const startedAt = Date.now();
    const result = await recoverUnresponsiveDaemon({
      pid: daemon.supervisorPid,
      probe,
      log: (message) => messages.push(message),
      timings: quick,
    });

    expect(result).toEqual({
      outcome: "responsive",
      pids: [daemon.supervisorPid, daemon.workerPid],
      woke: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(await probe(1_000)).toBe(true);
    expect(messages[0]).toContain("waking daemon with SIGCONT");
  });

  test("a daemon still silent after SIGCONT is terminated with its supervisor", async () => {
    const daemon = await startFakeDaemon("silent");
    process.kill(daemon.workerPid, "SIGSTOP");
    const result = await recoverUnresponsiveDaemon({
      pid: daemon.workerPid,
      probe: createHttpHealthProbe(`127.0.0.1:${daemon.port}`),
      log: () => {},
      timings: quick,
    });

    expect(result).toEqual({
      outcome: "replaced",
      pids: [daemon.supervisorPid, daemon.workerPid],
      forced: false,
    });
    expect(isRunning(daemon.workerPid)).toBe(false);
    expect(isRunning(daemon.supervisorPid)).toBe(false);
    expect(await findTcpListenHolders(daemon.port)).toEqual([]);
  });

  test("a daemon that ignores SIGTERM is killed", async () => {
    const daemon = await startFakeDaemon("ignore-term");
    const result = await recoverUnresponsiveDaemon({
      pid: daemon.supervisorPid,
      probe: createHttpHealthProbe(`127.0.0.1:${daemon.port}`),
      log: () => {},
      timings: quick,
    });

    expect(result).toMatchObject({ outcome: "replaced", forced: true });
    expect(isRunning(daemon.workerPid)).toBe(false);
  });

  test("a process that is not a Paseo daemon is never signalled", async () => {
    const scripts = await writeScripts();
    const port = await freePort();
    const foreign = spawn(process.execPath, [scripts.foreign], {
      env: { ...process.env, FAKE_PORT: String(port) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(foreign);
    await new Promise((resolve) => foreign.once("message", resolve));
    foreign.disconnect();
    process.kill(foreign.pid ?? 0, "SIGSTOP");

    const holders = await findTcpListenHolders(port);
    expect(holders.map((holder) => holder.pid)).toEqual([foreign.pid]);
    const result = await recoverUnresponsiveDaemon({
      pid: foreign.pid ?? 0,
      probe: createHttpHealthProbe(`127.0.0.1:${port}`),
      log: () => {},
      timings: quick,
    });

    expect(result.outcome).toBe("not_paseo");
    expect(isRunning(foreign.pid ?? 0)).toBe(true);
    expect((await readDaemonProcess(foreign.pid ?? 0))?.state).toMatch(/^T/);
  });
});
