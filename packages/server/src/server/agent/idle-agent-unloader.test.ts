import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ManagedAgent } from "./agent-manager.js";
import { IdleAgentUnloader, type IdleAgentUnloaderOptions } from "./idle-agent-unloader.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");

interface FakeAgentInput {
  id?: string;
  lifecycle?: ManagedAgent["lifecycle"];
  quietMinutes?: number;
  backgroundWaits?: number;
  pendingPermission?: boolean;
  internal?: boolean;
  sessionId?: string | null;
  parentId?: string;
  runtimePid?: number;
}

function fakeAgent(input: FakeAgentInput = {}): ManagedAgent {
  const at = new Date(NOW - (input.quietMinutes ?? 61) * MINUTE);
  const pid = input.runtimePid;
  return {
    id: input.id ?? "agent-1",
    lifecycle: input.lifecycle ?? "idle",
    provider: "pi",
    internal: input.internal ?? false,
    capabilities: { supportsSessionPersistence: true },
    persistence:
      input.sessionId === null ? null : { provider: "pi", sessionId: input.sessionId ?? "s-1" },
    pendingPermissions: new Map(input.pendingPermission ? [["p", {}]] : []),
    inFlightPermissionResponses: new Set(),
    pendingBackgroundWaits: input.backgroundWaits ?? 0,
    updatedAt: at,
    lastUserMessageAt: at,
    labels: input.parentId ? { [PARENT_AGENT_ID_LABEL]: input.parentId } : {},
    session: {
      backgroundWaits: { pending: input.backgroundWaits ?? 0, raisedAt: null, labels: [] },
      ...(pid !== undefined ? { getRuntimeProcessId: () => pid } : {}),
    },
  } as unknown as ManagedAgent;
}

function createUnloader(input: {
  agents: ManagedAgent[];
  scheduleTargets?: string[];
  children?: Record<number, number[] | null>;
  minutes?: number;
}) {
  const unloaded: string[] = [];
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const agentManager: IdleAgentUnloaderOptions["agentManager"] = {
    listAgents: () => input.agents,
    getAgent: (id) => byId.get(id) ?? null,
    getAgentLastActivityAt: (id) => byId.get(id)?.updatedAt.getTime() ?? null,
    hasInFlightRun: (id) => byId.get(id)?.lifecycle === "running",
    unloadIdleAgent: async (id, isEligible) => {
      const agent = byId.get(id);
      if (!agent || !(await isEligible(agent))) return false;
      unloaded.push(id);
      return true;
    },
  };
  const unloader = new IdleAgentUnloader({
    agentManager,
    getIdleUnloadMinutes: () => input.minutes ?? 60,
    listScheduleTargetAgentIds: async () => new Set(input.scheduleTargets ?? []),
    listChildProcessIds: async (pid) =>
      input.children && pid in input.children ? input.children[pid] : [],
    now: () => NOW,
    logger: createTestLogger(),
  });
  return { unloader, unloaded };
}

describe("IdleAgentUnloader", () => {
  it("unloads an agent idle for the configured minutes", async () => {
    const { unloader, unloaded } = createUnloader({ agents: [fakeAgent()] });
    await expect(unloader.sweep()).resolves.toEqual(["agent-1"]);
    expect(unloaded).toEqual(["agent-1"]);
  });

  it.each<[string, FakeAgentInput]>([
    ["a running agent", { lifecycle: "running" }],
    ["an agent active 59 minutes ago", { quietMinutes: 59 }],
    ["an agent with a pending background wait", { backgroundWaits: 1 }],
    ["an agent waiting on a permission", { pendingPermission: true }],
    ["an internal agent", { internal: true }],
    ["an agent with no session to resume", { sessionId: null }],
    ["an agent whose runtime has child processes", { runtimePid: 4242 }],
  ])("keeps %s loaded", async (_label, input) => {
    const { unloader, unloaded } = createUnloader({
      agents: [fakeAgent(input)],
      children: { 4242: [4243] },
    });
    await expect(unloader.sweep()).resolves.toEqual([]);
    expect(unloaded).toEqual([]);
  });

  it("keeps a schedule or heartbeat target loaded", async () => {
    const { unloader } = createUnloader({ agents: [fakeAgent()], scheduleTargets: ["agent-1"] });
    await expect(unloader.sweep()).resolves.toEqual([]);
  });

  it("keeps a subagent loaded while its orchestrator runs, and unloads it after", async () => {
    const parent = fakeAgent({ id: "parent", lifecycle: "running" });
    const child = fakeAgent({ id: "child", parentId: "parent" });
    const running = createUnloader({ agents: [parent, child] });
    await expect(running.unloader.sweep()).resolves.toEqual([]);

    const idleParent = fakeAgent({ id: "parent", quietMinutes: 5 });
    const settled = createUnloader({ agents: [idleParent, child] });
    await expect(settled.unloader.sweep()).resolves.toEqual(["child"]);
  });

  it("treats an unknown process tree as busy", async () => {
    const { unloader } = createUnloader({
      agents: [fakeAgent({ runtimePid: 7 })],
      children: { 7: null },
    });
    await expect(unloader.sweep()).resolves.toEqual([]);
  });

  it("unloads an agent whose runtime has no children", async () => {
    const { unloader } = createUnloader({
      agents: [fakeAgent({ runtimePid: 7 })],
      children: { 7: [] },
    });
    await expect(unloader.sweep()).resolves.toEqual(["agent-1"]);
  });

  it("does nothing when idleUnloadMinutes is 0", async () => {
    const { unloader } = createUnloader({
      agents: [fakeAgent({ quietMinutes: 10_000 })],
      minutes: 0,
    });
    await expect(unloader.sweep()).resolves.toEqual([]);
  });
});
