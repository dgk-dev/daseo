import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, test } from "vitest";
import pino from "pino";

import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { IdleAgentUnloader } from "../agent/idle-agent-unloader.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

process.env.PASEO_SUPERVISED = "0";

const TEST_TIMEOUT_MS = 240_000;
const MINUTE = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let canRun = false;

beforeAll(async () => {
  canRun = await canRunRealProvider("pi");
});

beforeEach((context) => {
  if (!canRun) {
    context.skip();
  }
});

// Delta 33: an idle Pi agent is unloaded after 60 quiet minutes (here a clock 61 minutes ahead),
// its process exits, and the next prompt resumes it with its history.
test(
  "real Pi agent unloads when idle and resumes with its history on the next prompt",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-idle-unload-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["pi"], logger),
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.45",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: `pi-idle-${randomUUID()}` } });
      const createStartedAt = Date.now();
      const agent = await client.createAgent({ cwd, ...getRealProviderConfig("pi") });
      const createMs = Date.now() - createStartedAt;
      await client.sendMessage(agent.id, "Reply with exactly: first-turn");
      expect((await client.waitForFinish(agent.id, TEST_TIMEOUT_MS)).status).toBe("idle");

      const agentManager = daemon.daemon.agentManager;
      const waitForRunning = async (since: number): Promise<number | null> => {
        while (Date.now() - since < 30_000) {
          if (agentManager.getAgent(agent.id)?.lifecycle === "running") return Date.now() - since;
          await sleep(20);
        }
        return null;
      };
      const warmSentAt = Date.now();
      await client.sendMessage(agent.id, "Reply with exactly: warm-turn");
      const warmTurnStartMs = await waitForRunning(warmSentAt);
      expect((await client.waitForFinish(agent.id, TEST_TIMEOUT_MS)).status).toBe("idle");
      const loaded = agentManager.getAgent(agent.id);
      const pid =
        loaded && loaded.lifecycle !== "closed" ? loaded.session.getRuntimeProcessId?.() : null;
      expect(pid).toEqual(expect.any(Number));
      const before = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });

      const unloader = new IdleAgentUnloader({
        agentManager,
        getIdleUnloadMinutes: () => 60,
        listScheduleTargetAgentIds: async () => new Set(),
        now: () => Date.now() + 61 * MINUTE,
        logger,
      });
      await expect(unloader.sweep()).resolves.toEqual([agent.id]);
      expect(agentManager.getAgent(agent.id)).toBeNull();
      const exitDeadline = Date.now() + 10_000;
      while (isAlive(pid as number) && Date.now() < exitDeadline) await sleep(100);
      expect(isAlive(pid as number)).toBe(false);

      // Split the cost: resume alone (what opening the agent triggers), then a prompt on the
      // resumed agent, against a prompt on an agent that was never unloaded.
      const resumeStartedAt = Date.now();
      await ensureAgentLoaded(agent.id, {
        agentManager,
        agentStorage: daemon.daemon.agentStorage,
        logger,
      });
      const resumeMs = Date.now() - resumeStartedAt;
      const sentAt = Date.now();
      await client.sendMessage(agent.id, "Reply with exactly: second-turn");
      const promptAfterResumeMs = await waitForRunning(sentAt);
      const turnStartMs = promptAfterResumeMs === null ? null : resumeMs + promptAfterResumeMs;
      expect((await client.waitForFinish(agent.id, TEST_TIMEOUT_MS)).status).toBe("idle");
      const resumed = agentManager.getAgent(agent.id);
      const resumedPid =
        resumed && resumed.lifecycle !== "closed" ? resumed.session.getRuntimeProcessId?.() : null;

      const after = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      const texts = after.entries.map((entry) => JSON.stringify(entry.item));
      console.info(
        JSON.stringify({
          piIdleUnloadE2E: {
            unloadedPid: pid,
            resumedPid,
            createMs,
            warmTurnStartMs,
            resumeMs,
            promptAfterResumeMs,
            turnStartMsAfterResume: turnStartMs,
            entriesBefore: before.entries.length,
            entriesAfter: after.entries.length,
          },
        }),
      );
      // Resuming costs what starting a Pi agent costs (spawn with the session file, Paseo
      // extension, and MCP config, then the first RPCs); the prompt itself starts at once.
      expect(turnStartMs).not.toBeNull();
      expect(promptAfterResumeMs as number).toBeLessThan(500);
      expect(resumeMs).toBeLessThan(createMs + 1_000);
      expect(resumedPid).not.toBe(pid);
      expect(after.epoch).toBe(before.epoch);
      expect(after.entries.slice(0, before.entries.length).map((entry) => entry.item)).toEqual(
        before.entries.map((entry) => entry.item),
      );
      expect(texts.some((text) => text.includes("first-turn"))).toBe(true);
      expect(texts.some((text) => text.includes("second-turn"))).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS * 2,
);
