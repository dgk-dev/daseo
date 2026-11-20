import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig, AgentSlashCommand } from "./agent-sdk-types.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import { CommandListCache } from "./command-list-cache.js";
import { listAgentCommands, type ListAgentCommandsDeps } from "./list-agent-commands.js";

const logger = pino({ level: "silent" });
const LIVE_LIST: AgentSlashCommand[] = [{ name: "live", description: "Live", argumentHint: "" }];
const DRAFT_LIST: AgentSlashCommand[] = [{ name: "draft", description: "Draft", argumentHint: "" }];

function storedRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const at = "2026-11-21T00:00:00.000Z";
  return {
    id: "agent-stored",
    provider: "pi",
    cwd: "/repo",
    createdAt: at,
    updatedAt: at,
    title: "stored",
    labels: {},
    lastStatus: "closed",
    config: { model: "anthropic/claude", modeId: "default" },
    persistence: null,
    ...overrides,
  } as StoredAgentRecord;
}

function liveAgent(listCommands?: () => Promise<AgentSlashCommand[]>): ManagedAgent {
  return {
    id: "agent-live",
    provider: "pi",
    cwd: "/repo",
    config: { provider: "pi", cwd: "/repo", model: "anthropic/claude" },
    session: listCommands ? { listCommands } : {},
  } as unknown as ManagedAgent;
}

interface Harness {
  deps: ListAgentCommandsDeps;
  listDraftCommands: ReturnType<typeof vi.fn>;
  cache: CommandListCache;
}

function createHarness(input: {
  live?: ManagedAgent;
  stored?: StoredAgentRecord;
  draftList?: AgentSlashCommand[];
}): Harness {
  const cache = new CommandListCache({ filePath: null, logger });
  const listDraftCommands = vi.fn(
    async (_config: AgentSessionConfig, _options?: { resolveDefaultModel?: boolean }) =>
      input.draftList ?? DRAFT_LIST,
  );
  const deps: ListAgentCommandsDeps = {
    agentManager: {
      getAgent: vi.fn((id: string) => (input.live && input.live.id === id ? input.live : null)),
      getRegisteredProviderIds: vi.fn(() => ["pi", "claude"]),
      listDraftCommands,
    },
    agentStorage: {
      get: vi.fn(async (id: string) =>
        input.stored && input.stored.id === id ? input.stored : null,
      ),
    } as unknown as ListAgentCommandsDeps["agentStorage"],
    commandListCache: cache,
    logger,
    liveListTimeoutMs: 20,
  };
  return { deps, listDraftCommands, cache };
}

describe("listAgentCommands (delta 138)", () => {
  it("answers a live agent from its session and caches the list for its provider and cwd", async () => {
    const { deps, listDraftCommands } = createHarness({
      live: liveAgent(async () => LIVE_LIST),
    });

    await expect(listAgentCommands(deps, { agentId: "agent-live" })).resolves.toEqual({
      commands: LIVE_LIST,
      error: null,
    });
    await expect(
      listAgentCommands(deps, {
        agentId: "",
        draftConfig: { provider: "pi", cwd: "/repo", model: "other-model" },
      }),
    ).resolves.toEqual({ commands: LIVE_LIST, error: null });
    expect(listDraftCommands).not.toHaveBeenCalled();
  });

  it("keeps the error for a live agent that cannot list commands", async () => {
    const { deps } = createHarness({ live: liveAgent() });

    await expect(listAgentCommands(deps, { agentId: "agent-live" })).resolves.toEqual({
      commands: [],
      error: "Agent does not support listing commands",
    });
  });

  it("answers a stored, unloaded agent without loading it, through one throwaway listing", async () => {
    const { deps, listDraftCommands } = createHarness({ stored: storedRecord() });

    await expect(listAgentCommands(deps, { agentId: "agent-stored" })).resolves.toEqual({
      commands: DRAFT_LIST,
      error: null,
    });
    await expect(listAgentCommands(deps, { agentId: "agent-stored" })).resolves.toEqual({
      commands: DRAFT_LIST,
      error: null,
    });

    expect(listDraftCommands).toHaveBeenCalledTimes(1);
    expect(listDraftCommands).toHaveBeenCalledWith(
      { provider: "pi", cwd: "/repo", modeId: "default", model: "anthropic/claude" },
      { resolveDefaultModel: true },
    );
  });

  it("answers a stored agent from a list a live session cached", async () => {
    const harness = createHarness({
      live: liveAgent(async () => LIVE_LIST),
      stored: storedRecord(),
    });
    await listAgentCommands(harness.deps, { agentId: "agent-live" });

    await expect(listAgentCommands(harness.deps, { agentId: "agent-stored" })).resolves.toEqual({
      commands: LIVE_LIST,
      error: null,
    });
    expect(harness.listDraftCommands).not.toHaveBeenCalled();
  });

  it("reports a stored agent whose provider is gone", async () => {
    const { deps } = createHarness({ stored: storedRecord({ provider: "gone" }) });

    await expect(listAgentCommands(deps, { agentId: "agent-stored" })).rejects.toThrow(
      "Agent agent-stored references unavailable provider 'gone'",
    );
  });

  it("answers a draft from the cache after the first request", async () => {
    const { deps, listDraftCommands } = createHarness({});
    const draftConfig = { provider: "pi", cwd: "/repo", model: "m1" };

    await listAgentCommands(deps, { agentId: "", draftConfig });
    await expect(
      listAgentCommands(deps, { agentId: "", draftConfig: { ...draftConfig, model: "m2" } }),
    ).resolves.toEqual({ commands: DRAFT_LIST, error: null });
    expect(listDraftCommands).toHaveBeenCalledTimes(1);
  });

  it("does not cache a draft without a model", async () => {
    const { deps, listDraftCommands } = createHarness({ draftList: [] });
    const draftConfig = { provider: "pi", cwd: "/repo" };

    await listAgentCommands(deps, { agentId: "", draftConfig });
    await listAgentCommands(deps, { agentId: "", draftConfig });
    expect(listDraftCommands).toHaveBeenCalledTimes(2);
  });

  it("falls back to the draft for an archived agent and reports a missing one", async () => {
    const { deps } = createHarness({
      stored: storedRecord({ archivedAt: "2026-11-21T01:00:00.000Z" }),
    });

    await expect(
      listAgentCommands(deps, {
        agentId: "agent-stored",
        draftConfig: { provider: "pi", cwd: "/repo", model: "m1" },
      }),
    ).resolves.toEqual({ commands: DRAFT_LIST, error: null });
    await expect(listAgentCommands(deps, { agentId: "agent-stored" })).resolves.toEqual({
      commands: [],
      error: "Agent not found: agent-stored",
    });
  });

  it("answers from the cache when the live listing fails", async () => {
    const { deps, listDraftCommands } = createHarness({
      live: liveAgent(async () => {
        throw new Error("pi process exited");
      }),
    });

    await expect(listAgentCommands(deps, { agentId: "agent-live" })).resolves.toEqual({
      commands: DRAFT_LIST,
      error: null,
    });
    expect(listDraftCommands).toHaveBeenCalledWith(
      { provider: "pi", cwd: "/repo", model: "anthropic/claude" },
      { resolveDefaultModel: true },
    );
  });

  it("answers from the cache when the live listing is slow, and stores the late live answer", async () => {
    let answerLive!: (commands: AgentSlashCommand[]) => void;
    const { deps, listDraftCommands } = createHarness({
      live: liveAgent(
        () =>
          new Promise<AgentSlashCommand[]>((resolve) => {
            answerLive = resolve;
          }),
      ),
    });

    await expect(listAgentCommands(deps, { agentId: "agent-live" })).resolves.toEqual({
      commands: DRAFT_LIST,
      error: null,
    });
    expect(listDraftCommands).toHaveBeenCalledTimes(1);

    answerLive(LIVE_LIST);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      listAgentCommands(deps, {
        agentId: "",
        draftConfig: { provider: "pi", cwd: "/repo", model: "m1" },
      }),
    ).resolves.toEqual({ commands: LIVE_LIST, error: null });
    expect(listDraftCommands).toHaveBeenCalledTimes(1);
  });
});
