import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentHistorySearchCandidate } from "../agent-history-search.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent/agent-storage.js";
import { FileBackedAgentTimelineStore } from "../agent/file-backed-agent-timeline-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createDaemonHistorySearch } from "./create-daemon-history-search.js";
import type { HistorySearchService } from "./history-search-service.js";

const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const PARENT_ID = "00000000-0000-4000-8000-0000000079a1";
const STORED_CHILD_ID = "00000000-0000-4000-8000-0000000079a2";
const LIVE_CHILD_ID = "00000000-0000-4000-8000-0000000079a3";

function storedRecord(id: string, labels: Record<string, string>, cwd: string): StoredAgentRecord {
  const at = "2026-11-01T00:00:00.000Z";
  return {
    id,
    provider: "codex",
    cwd,
    createdAt: at,
    updatedAt: at,
    title: id,
    labels,
    lastStatus: "closed",
    config: {},
    persistence: null,
  } as StoredAgentRecord;
}

function candidate(id: string): AgentHistorySearchCandidate {
  return {
    agent: { id, title: id, updatedAt: "2026-11-01T00:00:00.000Z", labels: {} },
    project: {
      projectKey: "/tmp/repo",
      projectName: "repo",
      workspaceName: "repo",
      checkout: { cwd: "/tmp/repo", isGit: false, currentBranch: null },
    },
  } as unknown as AgentHistorySearchCandidate;
}

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-history-detach-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "repo"));
  const storage = new AgentStorage(path.join(home, "agents"), logger);
  await storage.initialize();
  const timelines = new FileBackedAgentTimelineStore(path.join(home, "timelines"));
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    durableTimelineStore: timelines,
    logger,
  });
  return { home, storage, timelines, manager };
}

async function startHistorySearch(
  context: Awaited<ReturnType<typeof setup>>,
): Promise<HistorySearchService> {
  const service = await createDaemonHistorySearch({
    settings: { semantic: false },
    paseoHome: context.home,
    agentManager: context.manager,
    agentStorage: context.storage,
    durableTimelineStore: context.timelines,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    logger,
    startDelayMs: 0,
  });
  if (!service) throw new Error("History search did not open");
  cleanups.push(() => service.stop());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.idle();
  return service;
}

async function bodyMatches(service: HistorySearchService, agentId: string, query: string) {
  const results = await service.search({
    query,
    candidates: [candidate(agentId)],
    compareTies: () => 0,
    describeLimit: 1,
  });
  return results.filter((result) => result.searchSources.includes("content")).length > 0;
}

describe("History search follows detach without a restart", () => {
  test("a stored sub-agent's body becomes searchable once it is detached", async () => {
    const context = await setup();
    const cwd = path.join(context.home, "repo");
    await context.storage.upsert(storedRecord(PARENT_ID, {}, cwd));
    await context.storage.upsert(
      storedRecord(STORED_CHILD_ID, { [PARENT_AGENT_ID_LABEL]: PARENT_ID }, cwd),
    );
    await context.timelines.appendCommitted(STORED_CHILD_ID, {
      type: "user_message",
      text: "stored worker found the quarterly invoice drift",
    });
    const service = await startHistorySearch(context);
    expect(await bodyMatches(service, STORED_CHILD_ID, "invoice drift")).toBe(false);

    const result = await context.manager.detachAgent(STORED_CHILD_ID);
    expect(result.live).toBe(false);

    await vi.waitFor(
      async () => expect(await bodyMatches(service, STORED_CHILD_ID, "invoice drift")).toBe(true),
      { timeout: 5_000, interval: 100 },
    );
  });

  test("a live sub-agent's body becomes searchable once it is detached", async () => {
    const context = await setup();
    const cwd = path.join(context.home, "repo");
    await context.storage.upsert(storedRecord(PARENT_ID, {}, cwd));
    await context.manager.createAgent({ provider: "codex", cwd }, LIVE_CHILD_ID, {
      labels: { [PARENT_AGENT_ID_LABEL]: PARENT_ID },
      workspaceId: undefined,
    });
    await context.timelines.appendCommitted(LIVE_CHILD_ID, {
      type: "assistant_message",
      text: "live worker rotated the staging certificates",
    });
    const service = await startHistorySearch(context);
    expect(await bodyMatches(service, LIVE_CHILD_ID, "staging certificates")).toBe(false);

    const result = await context.manager.detachAgent(LIVE_CHILD_ID);
    expect(result.live).toBe(true);

    await vi.waitFor(
      async () =>
        expect(await bodyMatches(service, LIVE_CHILD_ID, "staging certificates")).toBe(true),
      { timeout: 5_000, interval: 100 },
    );
    await context.manager.closeAgent(LIVE_CHILD_ID);
  });
});
