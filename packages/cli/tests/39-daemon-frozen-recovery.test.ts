#!/usr/bin/env npx tsx

/**
 * Delta 126 regression: a real supervised daemon stopped with SIGSTOP (the stand-in for the
 * kernel's swap-exhaustion suspension, which is not reproduced here) is woken by the recovery the
 * desktop runs, and the connected client answers again; a daemon that stays silent is replaced and
 * a fresh daemon is reachable within about 30 s.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import {
  createHttpHealthProbe,
  recoverUnresponsiveDaemon,
} from "../../server/src/server/daemon-recovery.ts";
import { connectToDaemon } from "../src/utils/client.ts";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

const testEnv = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(200);
  }
}

async function readStatus(
  paseoHome: string,
): Promise<{ localDaemon: string | null; pid: number | null }> {
  const result =
    await $`PASEO_HOME=${paseoHome} npx paseo daemon status --home ${paseoHome} --json`.nothrow();
  try {
    const parsed = JSON.parse(result.stdout) as { localDaemon?: unknown; pid?: unknown };
    return {
      localDaemon: typeof parsed.localDaemon === "string" ? parsed.localDaemon : null,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
    };
  } catch {
    return { localDaemon: null, pid: null };
  }
}

async function readWorkerPid(paseoHome: string, supervisorPid: number): Promise<number> {
  const ps = await $`ps -A -o pid=,ppid=,command=`;
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid, ...command] = line.trim().split(/\s+/);
    if (Number(ppid) === supervisorPid && command.join(" ").startsWith("Paseo Daemon")) {
      return Number(pid);
    }
  }
  throw new Error(`no worker under supervisor ${supervisorPid} (home ${paseoHome})`);
}

console.log("=== Frozen daemon recovery (delta 126) ===\n");

const port = await getAvailablePort();
const listen = `127.0.0.1:${port}`;
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-frozen-daemon-"));
const cliRoot = join(import.meta.dirname, "..");
const supervisors: ChildProcess[] = [];

function startSupervisor(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "../server/scripts/supervisor-entrypoint.ts", "--dev"],
    {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...testEnv,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: listen,
        PASEO_RELAY_ENABLED: "false",
        PASEO_NODE_INSPECT: "0",
        CI: "true",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  supervisors.push(child);
  return child;
}

const probe = createHttpHealthProbe(listen);

try {
  console.log("Test 1: a SIGSTOPped daemon is woken and the client answers again");
  const supervisor = startSupervisor();
  await waitFor(() => probe(1000), 120_000, "daemon did not start");
  const supervisorPid = supervisor.pid ?? 0;
  const workerPid = await readWorkerPid(paseoHome, supervisorPid);
  const client = await connectToDaemon({ host: listen, timeout: 10_000 });

  process.kill(workerPid, "SIGSTOP");
  process.kill(supervisorPid, "SIGSTOP");
  assert.equal(await probe(1500), false, "a stopped daemon must not answer");
  const frozen = await readStatus(paseoHome);
  assert.equal(frozen.localDaemon, "unresponsive", "status must report the stopped daemon");

  const wakeStartedAt = Date.now();
  const woken = await recoverUnresponsiveDaemon({
    pid: supervisorPid,
    probe,
    log: (message) => console.log(`  ${message}`),
  });
  const wakeMs = Date.now() - wakeStartedAt;
  assert.equal(woken.outcome, "responsive", JSON.stringify(woken));
  const pingStartedAt = Date.now();
  await client.ping({ timeoutMs: 10_000 });
  console.log(
    `✓ woken in ${wakeMs} ms; the open client answered a ping ${Date.now() - pingStartedAt} ms later\n`,
  );
  await client.close();

  console.log("Test 2: a daemon that stays silent is replaced and a fresh one is reachable");
  process.kill(workerPid, "SIGSTOP");
  process.kill(supervisorPid, "SIGSTOP");
  const replaceStartedAt = Date.now();
  // A probe that never succeeds stands in for a daemon SIGCONT cannot bring back.
  const replaced = await recoverUnresponsiveDaemon({
    pid: supervisorPid,
    probe: async (timeoutMs) => {
      await sleep(Math.min(timeoutMs, 500));
      return false;
    },
    log: (message) => console.log(`  ${message}`),
  });
  assert.equal(replaced.outcome, "replaced", JSON.stringify(replaced));
  assert(
    !isProcessRunning(supervisorPid) && !isProcessRunning(workerPid),
    "old daemon must be gone",
  );
  startSupervisor();
  await waitFor(() => probe(1000), 60_000, "fresh daemon did not start");
  const reconnected = await connectToDaemon({ host: listen, timeout: 10_000 });
  await reconnected.ping({ timeoutMs: 5_000 });
  await reconnected.close();
  const replaceMs = Date.now() - replaceStartedAt;
  console.log(
    `✓ replaced (${JSON.stringify(replaced)}); a new client connected ${replaceMs} ms after recovery began`,
  );
  assert(replaceMs < 30_000, `replacement took ${replaceMs} ms`);
  console.log("");
} finally {
  for (const child of supervisors) {
    if (child.pid && isProcessRunning(child.pid)) {
      try {
        process.kill(child.pid, "SIGCONT");
      } catch {
        // gone
      }
    }
  }
  await $`PASEO_HOME=${paseoHome} npx paseo daemon stop --home ${paseoHome} --force`.nothrow();
  for (const child of supervisors) {
    if (child.pid && isProcessRunning(child.pid)) child.kill("SIGKILL");
  }
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Frozen daemon recovery test passed ===");
