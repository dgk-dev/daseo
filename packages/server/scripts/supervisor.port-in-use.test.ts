import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";

// Delta 126: a worker that cannot listen because the port is taken is restarted after growing
// delays, the supervisor names the port holder, replaces an old Paseo daemon that does not answer,
// and never signals anything else.

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

const WORKER = `
import net from "node:net";
const port = Number(process.env.FIXTURE_PORT);
const listen = "127.0.0.1:" + port;
const server = net.createServer();
server.once("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  process.send({ type: "paseo:listen-in-use", listen }, () => process.exit(1));
});
server.listen(port, "127.0.0.1", () => process.send({ type: "paseo:ready", listen }));
`;

const OLD_PASEO_DAEMON = `
process.title = "Paseo Daemon";
const http = require("node:http");
http.createServer((req, res) => res.end("ok")).listen(Number(process.env.FIXTURE_PORT), "127.0.0.1", () => {
  process.send("ready");
  for (;;) {}
});
`;

const FOREIGN = `
const net = require("node:net");
net.createServer(() => {}).listen(Number(process.env.FIXTURE_PORT), "127.0.0.1", () => process.send("ready"));
`;

const processes: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, "SIGCONT");
        process.kill(child.pid, "SIGKILL");
      } catch {
        // gone
      }
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startHolder(dir: string, source: string, port: number): Promise<ChildProcess> {
  const file = path.join(dir, "port-holder-fixture-with-a-long-name.cjs");
  await writeFile(file, source);
  const holder = spawn(process.execPath, [file], {
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  processes.push(holder);
  await new Promise((resolve) => holder.once("message", resolve));
  holder.disconnect();
  return holder;
}

async function runSupervisorUntil(options: {
  dir: string;
  port: number;
  until: (log: string) => boolean;
  timeoutMs: number;
}): Promise<{ log: string; stderr: string; elapsedMs: number }> {
  const workerPath = path.join(options.dir, "worker.mjs");
  const runnerPath = path.join(options.dir, "runner.mjs");
  const logPath = path.join(options.dir, "daemon.log");
  await writeFile(workerPath, WORKER);
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};
      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: { ...process.env, FIXTURE_PORT: ${JSON.stringify(String(options.port))} },
        workerExecArgv: [],
        restartOnCrash: true,
        crashRestartDelaysMs: [200, 400, 800, 1600, 3000],
        portHolderRecoveryTimings: {
          wakeWindowMs: 1000,
          probeTimeoutMs: 300,
          probeIntervalMs: 100,
          terminateGraceMs: 1000,
          killGraceMs: 2000,
        },
        logFile: { path: ${JSON.stringify(logPath)}, rotate: { maxSize: "1m", maxFiles: 2 } },
      });
    `,
  );
  const startedAt = Date.now();
  const supervisor = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  processes.push(supervisor);
  let stderr = "";
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const readLog = () => readFile(logPath, "utf8").catch(() => "");
  let log = await readLog();
  while (!options.until(log) && Date.now() - startedAt < options.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    log = await readLog();
  }
  const elapsedMs = Date.now() - startedAt;
  const exited = new Promise((resolve) => supervisor.once("close", resolve));
  supervisor.kill("SIGTERM");
  await exited;
  return { log: await readLog(), stderr, elapsedMs };
}

function countLines(log: string, message: string): number {
  return log.split("\n").filter((line) => line.includes(`"msg":"${message}"`)).length;
}

describe.skipIf(isPlatform("win32"))("supervisor with a taken listen port (delta 126)", () => {
  test("backs off, names a foreign holder, and never signals it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-port-"));
    tempDirs.push(dir);
    const port = await freePort();
    const foreign = await startHolder(dir, FOREIGN, port);
    const holderCheck = `held by PID ${foreign.pid}`;

    const { log, stderr, elapsedMs } = await runSupervisorUntil({
      dir,
      port,
      until: (current) => countLines(current, "Spawning worker") >= 5,
      timeoutMs: 15_000,
    });

    const spawns = countLines(log, "Spawning worker");
    expect(spawns).toBe(5);
    // Delays 200 + 400 + 800 + 1600 ms before the fifth worker; immediate restarts took ~0.1 s each.
    expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(stderr).toContain("Restarting worker in 200 ms");
    expect(stderr).toContain("Restarting worker in 400 ms");
    expect(stderr).toContain("Restarting worker in 800 ms");
    expect(stderr).toContain(holderCheck);
    expect(stderr).toContain("not a Paseo daemon, leaving it alone");
    expect(log).toContain(`"holderPid":${foreign.pid}`);
    expect(isRunning(foreign.pid ?? 0)).toBe(true);
  }, 30_000);

  test("replaces a stopped old Paseo daemon holding the port, then the worker starts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-port-"));
    tempDirs.push(dir);
    const port = await freePort();
    const oldDaemon = await startHolder(dir, OLD_PASEO_DAEMON, port);
    process.kill(oldDaemon.pid ?? 0, "SIGSTOP");

    const { log, stderr } = await runSupervisorUntil({
      dir,
      port,
      until: (current) => current.includes('"msg":"Worker ready"'),
      timeoutMs: 20_000,
    });

    expect(log).toContain('"msg":"Worker ready"');
    expect(stderr).toContain(`held by PID ${oldDaemon.pid} (Paseo Daemon`);
    expect(log).toContain("Unresponsive daemon recovery: waking daemon with SIGCONT");
    expect(log).toContain('"outcome":"replaced"');
    expect(isRunning(oldDaemon.pid ?? 0)).toBe(false);
    // Three taken-port workers, then the one that listens.
    expect(countLines(log, "Spawning worker")).toBe(4);
  }, 30_000);
});
