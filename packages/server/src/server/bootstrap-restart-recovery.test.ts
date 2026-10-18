import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { AgentClient, AgentPromptInput, AgentSession } from "./agent/agent-sdk-types.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const isRecoveryNotice = (prompt: string) => prompt.includes("Recovery notice");

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

/** A fake codex client whose sessions report one pending wait_for wait. */
function waitingCodexClient(): AgentClient {
  const base = createTestAgentClients().codex!;
  const holdWait = (session: AgentSession) => {
    Object.assign(session, {
      backgroundWaits: { pending: 1, raisedAt: Date.now(), labels: ["web build"] },
    });
    return session;
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "createSession" || property === "resumeSession") {
        return async (...args: unknown[]) =>
          holdWait(await (value as (...a: unknown[]) => Promise<AgentSession>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("restart recovery (DASEO.md delta 44)", () => {
  test("an agent idle on a background wait at shutdown is prompted after the next start", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-restart-recovery-"));
    try {
      const first = await createTestPaseoDaemon({
        paseoHomeRoot,
        cleanup: false,
        agentClients: { codex: waitingCodexClient() },
      });
      const created = await first.daemon.agentManager.createAgent(
        { provider: "codex", cwd: paseoHomeRoot, title: "deploys and waits" },
        undefined,
        { workspaceId: undefined },
      );
      await first.daemon.agentManager.runAgent(created.id, "start the build and wait for it");
      await first.daemon.agentManager.flush();
      expect(first.daemon.agentManager.getAgent(created.id)?.pendingBackgroundWaits).toBe(1);
      await first.close();

      const journal = JSON.parse(
        await readFile(path.join(paseoHomeRoot, ".paseo", "restart-recovery.json"), "utf8"),
      );
      expect(journal.agents[created.id].waits).toEqual({ pending: 1, labels: ["web build"] });

      const prompts: string[] = [];
      const second = await createTestPaseoDaemon({
        paseoHomeRoot,
        cleanup: false,
        agentClients: createTestAgentClients({
          onStartTurn: (prompt) => prompts.push(promptText(prompt)),
        }),
      });
      try {
        await expect
          .poll(() => prompts.find(isRecoveryNotice), {
            timeout: 15_000,
            interval: 200,
          })
          .toContain("1 background wait(s) you registered with wait_for were stopped");
        expect(prompts.find(isRecoveryNotice)).toContain("Daseo restarted at");
      } finally {
        await second.close();
      }
    } finally {
      await rm(paseoHomeRoot, { recursive: true, force: true });
    }
  }, 40_000);
});
