#!/usr/bin/env node
// Local fork (DASEO.md delta 44): the moment a Daseo activation may replace the app and daemon.
//
// Replacing the daemon ends every Pi process, so a running turn is cut off and a pending wait_for
// wait dies. The gate waits until one agent-list snapshot shows no running agent AND no pending
// background wait, then checks again after a settle window, because an agent that just went idle
// often registers a wait in the next seconds (2026-10-05: wait registered at 11:29:20, the old
// three-loop gate replaced the daemon at 11:29:53). Background waits are honored for at most
// --max-wait-minutes; past that the gate proceeds and the daemon's restart recovery prompts the
// affected agents after the restart. Run it once before the slow steps (smoke test, bundle copy)
// and once with --settle-seconds 0 right before quitting the app.

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function classifyAgents(agents) {
  const busy = [];
  const waiting = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const id = String(agent?.shortId ?? agent?.id ?? "unknown");
    if (agent?.status === "running" || agent?.status === "initializing") busy.push(id);
    const waits = Number(agent?.backgroundWaits ?? 0);
    if (waits > 0) waiting.push(`${id}(${waits})`);
  }
  return { busy, waiting };
}

function listAgents(cli) {
  return new Promise((resolve) => {
    execFile(
      cli,
      ["ls", "-g", "--json"],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function blockers({ busy, waiting }, waitCapReached) {
  const parts = [];
  if (busy.length > 0) parts.push(`busy agents: ${busy.join(",")}`);
  if (waiting.length > 0 && !waitCapReached) parts.push(`background waits: ${waiting.join(",")}`);
  return parts;
}

/**
 * Resolve when a snapshot is clean and stays clean for `settleMs`.
 * `snapshot()` returns the agent list or null when the daemon cannot be read (treated as busy).
 */
export async function waitForSafeMoment({
  snapshot,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = (line) => console.log(line),
  pollMs = 15_000,
  settleMs = 20_000,
  maxWaitMs = 90 * 60_000,
}) {
  let waitsSince = null;
  let waitCapLogged = false;
  const read = async () => {
    const agents = await snapshot();
    if (agents === null) return null;
    const state = classifyAgents(agents);
    waitsSince = state.waiting.length > 0 ? (waitsSince ?? now()) : null;
    const waitCapReached = waitsSince !== null && now() - waitsSince >= maxWaitMs;
    if (waitCapReached && !waitCapLogged) {
      log(
        `[${stamp()}] background waits still pending after ${Math.round(maxWaitMs / 60_000)}m (${state.waiting.join(",")}); proceeding, restart recovery will notify those agents`,
      );
      waitCapLogged = true;
    }
    return { ...state, blocked: blockers(state, waitCapReached) };
  };
  for (;;) {
    const state = await read();
    if (state === null) {
      log(`[${stamp()}] agent list unavailable; retrying`);
      await sleep(pollMs);
      continue;
    }
    if (state.blocked.length > 0) {
      log(`[${stamp()}] waiting on ${state.blocked.join("; ")}`);
      await sleep(pollMs);
      continue;
    }
    if (settleMs <= 0) return { waiting: state.waiting };
    await sleep(settleMs);
    const again = await read();
    if (again !== null && again.blocked.length === 0) return { waiting: again.waiting };
    log(`[${stamp()}] an agent became active during the settle window; waiting again`);
  }
}

function parseArgs(argv) {
  const options = { maxWaitMinutes: 90, settleSeconds: 20, pollSeconds: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--cli") options.cli = value;
    else if (flag === "--max-wait-minutes") options.maxWaitMinutes = Number(value);
    else if (flag === "--settle-seconds") options.settleSeconds = Number(value);
    else if (flag === "--poll-seconds") options.pollSeconds = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!options.cli) throw new Error("--cli <path to the paseo CLI> is required");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  await waitForSafeMoment({
    snapshot: () => listAgents(options.cli),
    pollMs: options.pollSeconds * 1000,
    settleMs: options.settleSeconds * 1000,
    maxWaitMs: options.maxWaitMinutes * 60_000,
  });
  console.log(`[${stamp()}] safe moment: no running agent and no pending background wait`);
}
