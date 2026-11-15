import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
} from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { ReplicaCache, type ReplicaCacheStorage } from ".";

const SERVER_ID = "cached-host";
const LRU_SERVER_IDS = ["host-a", "host-b", "host-c"] as const;

class MemoryStorage implements ReplicaCacheStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  readonly written: Array<{ key: string; bytes: number }> = [];
  readonly reads: string[] = [];

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.values.keys());
  }

  async getItem(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.written.push({ key, bytes: Buffer.byteLength(value) });
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function workspace(
  id = "workspace-1",
  projectId = "project-1",
  workspaceDirectory = "/repo/paseo",
): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: "Paseo",
    projectRootPath: workspaceDirectory,
    workspaceDirectory,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    statusEnteredAt: "2026-07-18T08:00:00.000Z",
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function agent(id: string, workspaceId = "workspace-1", cwd = "/repo/paseo") {
  return {
    ...normalizeAgentSnapshot(
      {
        id,
        provider: "codex",
        cwd,
        workspaceId,
        model: null,
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-18T08:01:00.000Z",
        lastUserMessageAt: "2026-07-18T08:01:00.000Z",
        status: "idle",
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
        currentModeId: null,
        availableModes: [],
        pendingPermissions: [],
        persistence: null,
        title: `Agent ${id}`,
        labels: {},
      },
      SERVER_ID,
    ),
    projectPlacement: {
      projectKey: cwd,
      projectName: cwd.split("/").at(-1) ?? cwd,
      workspaceName: workspaceId,
      checkout: {
        cwd,
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      },
    },
  };
}

function message(
  id: string,
  text: string,
  turnOutcome?: "completed" | "failed" | "canceled",
  phase?: "commentary" | "final_answer",
): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq: 12 },
    ...(turnOutcome ? { turnOutcome } : {}),
    ...(phase ? { phase } : {}),
  };
}

function toolCall(): StreamItem {
  return {
    kind: "tool_call",
    id: "tool-1",
    timelineCursor: { epoch: "epoch-1", seq: 12 },
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "npm test",
          output: "passed",
          exitCode: 0,
        },
      },
    },
  };
}

function seedSession(): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null);
  store.setAgents(SERVER_ID, new Map([["agent-1", agent("agent-1")]]));
  store.setWorkspaces(
    SERVER_ID,
    new Map([
      [
        "workspace-1",
        normalizeWorkspaceDescriptor({
          ...workspace(),
          workspaceKind: "worktree",
          worktreeSlug: "owned-worktree",
        }),
      ],
    ]),
  );
  store.setProjects(SERVER_ID, [
    normalizeProjectDescriptor({
      projectId: "project-1",
      projectKey: "remote:github.com/getpaseo/paseo",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo/paseo",
      projectKind: "git",
    }),
    normalizeProjectDescriptor({
      projectId: "empty-project",
      projectDisplayName: "Empty project",
      projectRootPath: "/repo/empty",
      projectKind: "directory",
    }),
  ]);
  store.setFocusedAgentId(SERVER_ID, "agent-1");
  store.setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("message-1", "Cached")]]]));
  store.setAgentTimelineCursor(
    SERVER_ID,
    new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 12 }]]),
  );
  store.setAgentTimelineHasOlder(SERVER_ID, new Map([["agent-1", true]]));
  store.setAgentAuthoritativeHistoryApplied(SERVER_ID, "agent-1", true);
}

function seedTimeline(serverId: string, text: string): void {
  const agentId = `agent-${serverId}`;
  const workspaceId = `workspace-${serverId}`;
  const workspaceDirectory = `/repo/${serverId}`;
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  store.setAgents(serverId, new Map([[agentId, agent(agentId, workspaceId, workspaceDirectory)]]));
  store.setWorkspaces(
    serverId,
    new Map([
      [
        workspaceId,
        normalizeWorkspaceDescriptor(
          workspace(workspaceId, `project-${serverId}`, workspaceDirectory),
        ),
      ],
    ]),
  );
  store.setFocusedAgentId(serverId, agentId);
  store.setAgentStreamTail(serverId, new Map([[agentId, [message(`message-${serverId}`, text)]]]));
}

async function visitChats(cache: ReplicaCache, count: number, textBytes = 100_000): Promise<void> {
  seedSession();
  const store = useSessionStore.getState();
  store.setAgents(
    SERVER_ID,
    new Map(
      Array.from({ length: count }, (_, i) => {
        const id = `agent-${i + 1}`;
        return [id, agent(id)];
      }),
    ),
  );
  store.setAgentStreamTail(
    SERVER_ID,
    new Map(
      Array.from({ length: count }, (_, i) => {
        const id = `agent-${i + 1}`;
        return [id, [message(`message-${i + 1}`, "한".repeat(Math.ceil(textBytes / 3)))]];
      }),
    ),
  );
  for (let i = 1; i <= count; i++) {
    store.setFocusedAgentId(SERVER_ID, `agent-${i}`);
    await cache.flush();
  }
}

async function expectRestoredTimelines(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.size).toBe(count);
  });
}

afterEach(() => {
  vi.useRealTimers();
  const store = useSessionStore.getState();
  store.clearSession(SERVER_ID);
  for (const serverId of LRU_SERVER_IDS) store.clearSession(serverId);
});

describe("ReplicaCache", () => {
  it("restores all 20 visited chats after restart, reading the focused chat first", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    await visitChats(writer, 20);
    useSessionStore.getState().clearSession(SERVER_ID);
    storage.reads.length = 0;
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.has("agent-20")).toBe(
      true,
    );
    await expectRestoredTimelines(20);
    expect(storage.reads[1]).toContain("agent-20");
  });

  it.each([1, 20])(
    "writes less than twice the changed chat bytes with %i cached chats",
    async (count) => {
      const storage = new MemoryStorage();
      const cache = new ReplicaCache(storage);
      cache.setHosts([SERVER_ID]);
      await visitChats(cache, count);
      storage.written.length = 0;
      const id = `agent-${count}`;
      useSessionStore
        .getState()
        .setAgentStreamTail(SERVER_ID, (tails) =>
          new Map(tails).set(id, [message("changed", "한".repeat(34_000))]),
        );
      await cache.flush();
      const changedBytes = Buffer.byteLength(
        JSON.stringify([message("changed", "한".repeat(34_000))]),
      );
      expect(storage.written.reduce((sum, write) => sum + write.bytes, 0)).toBeLessThan(
        changedBytes * 2,
      );
      expect(storage.written.filter((write) => write.key !== "@paseo:replica-cache")).toHaveLength(
        1,
      );
    },
  );

  it("does not rewrite the directory or other chats for a small streaming change", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    await visitChats(cache, 20, 1_000);
    storage.written.length = 0;
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, (tails) =>
        new Map(tails).set("agent-20", [message("small", "한".repeat(400))]),
      );
    await cache.flush();
    expect(storage.written).toHaveLength(1);
    expect(storage.written[0]!.bytes).toBeLessThan(2_400);
  });

  it("paints the focused chat before a slow background read and never overwrites newer history", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    await visitChats(writer, 3, 100);
    const baseRead = storage.getItem.bind(storage);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.getItem = async (key) => {
      if (key.endsWith(":agent-2")) await gate;
      return baseRead(key);
    };
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(
      Array.from(useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.keys()),
    ).toEqual(["agent-3"]);
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, (tails) =>
        new Map(tails).set("agent-2", [message("network", "Newer")]),
      );
    release();
    await reader.flush();
    expect(useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.get("agent-2")).toEqual([
      message("network", "Newer"),
    ]);
    expect(useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.size).toBe(3);
  });

  it("cleans orphan keys and removed hosts without touching other storage", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    await visitChats(cache, 3, 100);
    storage.values.set("@paseo:replica-cache:timeline:interrupted-write", "orphan");
    storage.values.set("unrelated", "keep");
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    reader.setHosts([]);
    await reader.flush();
    expect(Array.from(storage.values.keys()).sort()).toEqual(["@paseo:replica-cache", "unrelated"]);
    expect(storage.values.get("unrelated")).toBe("keep");
  });

  it("restores the remaining chats when the focused disk value is corrupt", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    await visitChats(writer, 3, 100);
    const focusedKey = Array.from(storage.values.keys()).find((key) => key.endsWith(":agent-3"))!;
    storage.values.set(focusedKey, "{broken");
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    await reader.flush();
    expect(
      Array.from(useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.keys()),
    ).toEqual(["agent-2", "agent-1"]);
    expect(storage.values.has(focusedKey)).toBe(false);
  });

  it("stores a directory checkpoint even before the first persist", async () => {
    const storage = new MemoryStorage();
    seedSession();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    cache.writeDirectoryCheckpoint(SERVER_ID, { afterSeq: 7 });
    await cache.flush();
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(reader.readDirectoryCheckpoint(SERVER_ID)).toEqual({ afterSeq: 7 });
  });

  it("leaves version 8 readable if migration fails before publishing the new index", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    await visitChats(writer, 3, 100);
    const host = JSON.parse(storage.values.get("@paseo:replica-cache")!).hosts[0];
    const rows = host.timelineKeys.map((entry: { key: string }) =>
      JSON.parse(storage.values.get(entry.key)!),
    );
    const { timelineKeys: _keys, ...directory } = host;
    const legacy = JSON.stringify({
      version: 8,
      hosts: [{ ...directory, timeline: rows[0], timelines: rows.slice(1) }],
    });
    storage.values.clear();
    storage.values.set("@paseo:replica-cache", legacy);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => {
      if (key === "@paseo:replica-cache") throw new Error("Interrupted index write");
      await setItem(key, value);
    };
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    await reader.flush();
    expect(storage.values.get("@paseo:replica-cache")).toBe(legacy);
    storage.setItem = setItem;
    useSessionStore.getState().clearSession(SERVER_ID);
    const retry = new ReplicaCache(storage);
    retry.setHosts([SERVER_ID]);
    await retry.restore();
    await retry.flush();
    expect(useSessionStore.getState().sessions[SERVER_ID]!.agentStreamTail.size).toBe(3);
    expect(JSON.parse(storage.values.get("@paseo:replica-cache")!).version).toBe(9);
    expect(storage.values.size).toBe(4);
  });

  it("loads a version-8 single value and migrates it without losing canonical rows", async () => {
    const storage = new MemoryStorage();
    // Capture the actual v8 boundary rather than hand-writing a directory fixture.
    seedSession();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    await writer.flush();
    const current = JSON.parse(storage.values.get("@paseo:replica-cache") ?? "null");
    const host = current.hosts[0];
    const timeline =
      host.timeline ?? JSON.parse(storage.values.get(host.timelineKeys[0].key) ?? "null");
    storage.values.clear();
    storage.values.set(
      "@paseo:replica-cache",
      JSON.stringify({
        version: 8,
        hosts: [
          {
            ...host,
            timelineKeys: undefined,
            timeline,
            timelines: [],
          },
        ],
      }),
    );
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      message("message-1", "Cached"),
    ]);
    await reader.flush();
    expect(JSON.parse(storage.values.get("@paseo:replica-cache") ?? "null").version).toBe(9);
  });

  it("deletes the evicted timeline key when a 21st chat is visited", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    await visitChats(cache, 20);
    const firstKey = Array.from(storage.values.keys()).find((key) => key.endsWith(":agent-1"));
    expect(firstKey).toBeTypeOf("string");
    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (agents) => new Map(agents).set("agent-21", agent("agent-21")));
    store.setAgentStreamTail(SERVER_ID, (tails) =>
      new Map(tails).set("agent-21", [message("21", "new")]),
    );
    store.setFocusedAgentId(SERVER_ID, "agent-21");
    await cache.flush();
    expect(storage.values.has(firstKey!)).toBe(false);
    expect(storage.values.size).toBe(21);
  });

  it.each([400_000, 32 * 1024 * 1024])(
    "bounds stored UTF-8 bytes with 20 maximum-item timelines and a %i byte cap",
    async (maxBytes) => {
      const storage = new MemoryStorage();
      const cache = new ReplicaCache(storage, { maxBytes });
      cache.setHosts([SERVER_ID]);
      await visitChats(cache, 20, 100);
      for (let i = 1; i <= 20; i++) {
        const id = `agent-${i}`;
        useSessionStore.getState().setFocusedAgentId(SERVER_ID, id);
        const rows = Array.from({ length: 50 }, (_, row) =>
          message(`${i}-${row}`, "한".repeat(Math.ceil(maxBytes / (15 * 50 * 3)))),
        );
        useSessionStore
          .getState()
          .setAgentStreamTail(SERVER_ID, (tails) => new Map(tails).set(id, rows));
        await cache.flush();
        expect(
          Array.from(storage.values.values()).reduce(
            (sum, value) => sum + Buffer.byteLength(value),
            0,
          ),
        ).toBeLessThanOrEqual(maxBytes);
      }
      expect(storage.values.size).toBeGreaterThan(1);
    },
  );

  it("measures streaming writes and worst-case startup JSON deserialization", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    await visitChats(cache, 20, 842_000);
    const index = storage.values.get("@paseo:replica-cache")!;
    const host = JSON.parse(index).hosts[0];
    const rows = host.timelineKeys.map((entry: { key: string }) =>
      JSON.parse(storage.values.get(entry.key)!),
    );
    const { timelineKeys: _keys, ...directory } = host;
    const legacy20 = {
      version: 8,
      hosts: [{ ...directory, timeline: rows[0], timelines: rows.slice(1) }],
    };
    const legacy5 = {
      version: 8,
      hosts: [{ ...directory, timeline: rows[0], timelines: rows.slice(1, 5) }],
    };
    const old20 = JSON.stringify(legacy20);
    const focused = storage.values.get(host.timelineKeys[0].key)!;
    const oldParse: number[] = [];
    const focusedParse: number[] = [];
    for (let i = 0; i < 30; i++) {
      let start = performance.now();
      JSON.parse(old20);
      oldParse.push(performance.now() - start);
      start = performance.now();
      JSON.parse(index);
      JSON.parse(focused);
      focusedParse.push(performance.now() - start);
    }
    const before5: number[] = [];
    const before20: number[] = [];
    const after20: number[] = [];
    for (let chunk = 0; chunk < 10; chunk++) {
      const text = "한".repeat(280_667) + "x".repeat(chunk + 1);
      rows[0].items[0].text = text;
      before5.push(Buffer.byteLength(JSON.stringify(legacy5)));
      before20.push(Buffer.byteLength(JSON.stringify(legacy20)));
      storage.written.length = 0;
      useSessionStore
        .getState()
        .setAgentStreamTail(SERVER_ID, (tails) =>
          new Map(tails).set("agent-20", [message("message-20", text)]),
        );
      await cache.flush();
      after20.push(storage.written.reduce((sum, write) => sum + write.bytes, 0));
      expect(storage.written).toHaveLength(1);
    }
    const median = (values: number[]) =>
      values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
    process.stdout.write(
      "REPLICA_CACHE_MEASURED " +
        JSON.stringify({
          streamingBytesPerPersist: { old5: before5, old20: before20, new20: after20 },
          startupJsonBytes: {
            old20: Buffer.byteLength(old20),
            indexAndFocused: Buffer.byteLength(index) + Buffer.byteLength(focused),
          },
          startupJsonMedianMs: { old20: median(oldParse), indexAndFocused: median(focusedParse) },
        }) +
        "\n",
    );
    expect(Math.max(...after20)).toBeLessThan(Math.min(...before5));
  });

  it("persists focused replica changes without writing transient stream head updates", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();
    await cache.flush();
    cache.start();
    const writesBeforeStream = storage.writes;

    useSessionStore
      .getState()
      .setAgentStreamHead(SERVER_ID, new Map([["agent-1", [message("live", "Streaming")]]]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(storage.writes).toBe(writesBeforeStream);

    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("saved", "Committed")]]]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(storage.writes).toBeGreaterThan(writesBeforeStream);
    expect(storage.written.filter((write) => write.key !== "@paseo:replica-cache")).toHaveLength(2);
    cache.setHosts([]);
  });

  it("restores the exact persisted canonical timeline window", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);

    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected restored session");
    expect(session.client).toBeNull();
    expect(session.hasHydratedAgents).toBe(false);
    expect(session.hasHydratedWorkspaces).toBe(false);
    expect(session.hasWorkspaceDirectorySnapshot).toBe(true);
    expect(Array.from(session.agents.keys())).toEqual(["agent-1"]);
    expect(Array.from(session.workspaces.keys())).toEqual(["workspace-1"]);
    expect(Array.from(session.projects.keys())).toEqual(["project-1", "empty-project"]);
    expect(session.agents.get("agent-1")?.updatedAt).toBeInstanceOf(Date);
    expect(session.agents.get("agent-1")?.projectPlacement?.checkout.cwd).toBe("/repo/paseo");
    expect(session.workspaces.get("workspace-1")?.statusEnteredAt).toBeInstanceOf(Date);
    expect(session.workspaces.get("workspace-1")?.worktreeSlug).toBe("owned-worktree");
    expect(session.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
    expect(session.agentAuthoritativeHistoryApplied).toEqual(new Map([["agent-1", true]]));
    expect(session.agentTimelineCursor).toEqual(
      new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 12 }]]),
    );
    expect(session.agentTimelineHasOlder).toEqual(new Map([["agent-1", true]]));
    expect(session.agentTimelineHasNewer).toEqual(new Map([["agent-1", false]]));
    expect(session.agentHistorySyncGeneration).toEqual(new Map());
    expect(selectAgentTimelineState(session, "agent-1")).toEqual({
      status: "synced",
      items: [message("message-1", "Cached")],
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 12 },
      older: "available",
      newer: "none",
    });
  });

  it("restores terminal turn outcomes used by safe transcript folding", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore
      .getState()
      .setAgentStreamTail(
        SERVER_ID,
        new Map([["agent-1", [message("message-1", "Interrupted", "canceled")]]]),
      );
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      message("message-1", "Interrupted", "canceled"),
    ]);
  });

  it("restores assistant message phases used by transcript folding", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore.getState().setAgentStreamTail(
      SERVER_ID,
      new Map([
        [
          "agent-1",
          [
            createUserMessage({
              clientMessageId: "steering-user",
              text: "new context",
              steering: true,
              timelineCursor: { epoch: "epoch-1", seq: 11 },
              timestamp: new Date("2026-07-18T08:01:59.000Z"),
            }),
            message("commentary", "Working", undefined, "commentary"),
            message("final", "Done", "completed", "final_answer"),
          ],
        ],
      ]),
    );
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      createUserMessage({
        clientMessageId: "steering-user",
        text: "new context",
        steering: true,
        timelineCursor: { epoch: "epoch-1", seq: 11 },
        timestamp: new Date("2026-07-18T08:01:59.000Z"),
      }),
      message("commentary", "Working", undefined, "commentary"),
      message("final", "Done", "completed", "final_answer"),
    ]);
  });

  it("restores the system origin of a system prompt boundary row", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    const systemPrompt = createUserMessage({
      messageId: "system-prompt",
      text: "<paseo-system>\nAgent a (Implement) finished.\n</paseo-system>",
      origin: "system",
      timelineCursor: { epoch: "epoch-1", seq: 12 },
      timestamp: new Date("2026-09-23T08:00:00.000Z"),
    });
    useSessionStore
      .getState()
      .setAgentStreamTail(
        SERVER_ID,
        new Map([["agent-1", [systemPrompt, message("final", "Reviewed", "completed")]]]),
      );
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      systemPrompt,
      message("final", "Reviewed", "completed"),
    ]);
  });

  it("restores canonical attachment presentation with authoritative coverage", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    const userMessage = createUserMessage({
      clientMessageId: "attachment-user",
      messageId: "attachment-user",
      text: "",
      imageCount: 1,
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Browser element · button",
          text: "<browser-element>button</browser-element>",
        },
      ],
      timelineCursor: { epoch: "epoch-1", seq: 12 },
      timestamp: new Date("2026-07-18T08:01:59.000Z"),
    });
    useSessionStore.getState().setAgentStreamTail(SERVER_ID, new Map([["agent-1", [userMessage]]]));
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.get("agent-1")).toEqual([userMessage]);
    expect(session?.agentTimelineCursor.get("agent-1")).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 12,
    });
  });

  it("restores tool calls inside an authoritative cached window", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore.getState().setAgentStreamTail(SERVER_ID, new Map([["agent-1", [toolCall()]]]));
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.get("agent-1")).toEqual([toolCall()]);
    expect(session?.agentTimelineCursor.get("agent-1")).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 12,
    });
  });

  it("restores display-only when retained items do not reach the stored range end", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        SERVER_ID,
        new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 13 }]]),
      );
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
    expect(session?.agentTimelineCursor).toEqual(new Map());
    expect(selectAgentTimelineState(session, "agent-1")).toEqual({
      status: "painted",
      items: [message("message-1", "Cached")],
    });
  });

  it("persists the complete directory with only the focused timeline tail", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();

    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (agents) =>
      new Map(agents).set("agent-2", agent("agent-2", "workspace-2", "/repo/other")),
    );
    store.setWorkspaces(SERVER_ID, (workspaces) =>
      new Map(workspaces).set(
        "workspace-2",
        normalizeWorkspaceDescriptor(workspace("workspace-2", "project-2", "/repo/other")),
      ),
    );
    const secondTimeline = Array.from({ length: 60 }, (_, index) => ({
      ...message(`message-${index}`, `Second ${index}`),
      timelineCursor: { epoch: "epoch-2", seq: index + 1 },
    }));
    store.setAgentStreamTail(
      SERVER_ID,
      new Map([
        ["agent-1", [message("message-1", "First")]],
        ["agent-2", secondTimeline],
      ]),
    );
    store.setAgentTimelineCursor(
      SERVER_ID,
      new Map([["agent-2", { epoch: "epoch-2", startSeq: 1, endSeq: 60 }]]),
    );
    store.setAgentTimelineHasOlder(SERVER_ID, new Map([["agent-2", true]]));
    store.setAgentAuthoritativeHistoryApplied(SERVER_ID, "agent-2", true);
    store.setFocusedAgentId(SERVER_ID, "agent-2");
    await cache.flush();

    store.clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const timelines = session?.agentStreamTail;
    expect(Array.from(session?.agents.keys() ?? [])).toEqual(["agent-1", "agent-2"]);
    expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["workspace-1", "workspace-2"]);
    expect(Array.from(session?.projects.keys() ?? [])).toEqual([
      "project-1",
      "project-2",
      "empty-project",
    ]);
    expect(Array.from(timelines?.keys() ?? [])).toEqual(["agent-2"]);
    expect(timelines?.get("agent-2")).toEqual(secondTimeline.slice(-50));
    expect(session?.agentTimelineCursor.has("agent-2")).toBe(false);
    expect(selectAgentTimelineState(session, "agent-2")).toEqual({
      status: "painted",
      items: secondTimeline.slice(-50),
    });

    const persisted = JSON.parse(storage.values.get("@paseo:replica-cache") ?? "null") as {
      version: number;
      hosts: Array<{ timelineKeys: Array<{ key: string }> }>;
    };
    expect(persisted.version).toBe(9);
    const timelineKey = persisted.hosts[0]!.timelineKeys[0]!.key;
    expect(Object.keys(JSON.parse(storage.values.get(timelineKey) ?? "null")).sort()).toEqual([
      "agentId",
      "hasOlder",
      "items",
      "range",
    ]);
  });

  it("keeps an LRU of recently focused agent timelines", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();
    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (agents) =>
      new Map(agents).set("agent-2", agent("agent-2", "workspace-1", "/repo/main")),
    );
    store.setAgentStreamTail(
      SERVER_ID,
      new Map([
        ["agent-1", [message("message-1", "First cached agent")]],
        ["agent-2", [message("message-2", "Second cached agent")]],
      ]),
    );

    store.setFocusedAgentId(SERVER_ID, "agent-1");
    await cache.flush();
    store.setFocusedAgentId(SERVER_ID, "agent-2");
    await cache.flush();
    store.clearSession(SERVER_ID);

    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    await expectRestoredTimelines(2);
    const timelines = useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail;
    expect(Array.from(timelines?.keys() ?? [])).toEqual(["agent-2", "agent-1"]);
    expect(timelines?.get("agent-1")).toEqual([message("message-1", "First cached agent")]);
    expect(timelines?.get("agent-2")).toEqual([message("message-2", "Second cached agent")]);
  });

  it("persists reconciled rows without caching unreconciled local presentations", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();
    const unreconciled = createUserMessage({
      clientMessageId: "client-pending",
      text: "Pending",
      timestamp: new Date("2026-07-18T08:01:00.000Z"),
    });
    const reconciled = createUserMessage({
      clientMessageId: "client-sent",
      messageId: "provider-sent",
      timelineCursor: { epoch: "epoch-1", seq: 11 },
      text: "Sent",
      timestamp: new Date("2026-07-18T08:01:30.000Z"),
    });
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [unreconciled, reconciled]]]));

    await cache.flush();
    useSessionStore.getState().clearSession(SERVER_ID);
    await cache.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      reconciled,
    ]);
  });

  it("persists monotonic directory cursors with the complete host replica", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();
    await cache.flush();

    cache.writeDirectoryCheckpoint(SERVER_ID, {
      agents: { generation: "daemon-generation", afterSeq: 7 },
    });
    useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
      const current = agents.get("agent-1");
      if (!current) throw new Error("Expected seeded agent");
      return new Map(agents).set("agent-1", { ...current, title: "Updated agent" });
    });
    await cache.flush();

    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(reader.readDirectoryCheckpoint(SERVER_ID)).toEqual({
      agents: { generation: "daemon-generation", afterSeq: 7 },
    });
  });

  it("restores every registered host directory before any host reconnects", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts(LRU_SERVER_IDS);
    for (const serverId of LRU_SERVER_IDS) seedTimeline(serverId, `cached-${serverId}`);
    await writer.flush();
    for (const serverId of LRU_SERVER_IDS) useSessionStore.getState().clearSession(serverId);

    const reader = new ReplicaCache(storage);
    reader.setHosts(LRU_SERVER_IDS);
    await reader.restore();

    for (const serverId of LRU_SERVER_IDS) {
      const session = useSessionStore.getState().sessions[serverId];
      expect(Array.from(session?.agents.keys() ?? [])).toEqual([`agent-${serverId}`]);
      expect(Array.from(session?.workspaces.keys() ?? [])).toEqual([`workspace-${serverId}`]);
      expect(session?.hasHydratedAgents).toBe(false);
      expect(session?.hasHydratedWorkspaces).toBe(false);
      expect(session?.hasWorkspaceDirectorySnapshot).toBe(true);
    }
  });

  it("evicts the least recently written host when the cache exceeds its byte budget", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage, { maxBytes: 7_000 });
    cache.setHosts(LRU_SERVER_IDS.slice(0, 2));
    seedTimeline("host-a", "A".repeat(1_200));
    seedTimeline("host-b", "B".repeat(1_200));
    await cache.flush();

    seedTimeline("host-a", "A".repeat(1_201));
    await cache.flush();

    cache.setHosts(LRU_SERVER_IDS);
    seedTimeline("host-c", "C".repeat(1_200));
    await cache.flush();

    for (const serverId of LRU_SERVER_IDS) {
      useSessionStore.getState().clearSession(serverId);
    }
    const reader = new ReplicaCache(storage, { maxBytes: 7_000 });
    reader.setHosts(LRU_SERVER_IDS);
    await reader.restore();

    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual(["host-a", "host-c"]);
  });

  it("rejects and clears version 5 cache data before overwriting it on flush", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      "@paseo:replica-cache",
      JSON.stringify({
        version: 5,
        hosts: [
          {
            serverId: SERVER_ID,
            agents: [],
            workspaces: [],
            emptyProjects: [],
            timeline: {
              agentId: "agent-1",
              items: [],
              cursor: { epoch: "poisoned", startSeq: 1, endSeq: 100 },
              hasOlder: false,
            },
          },
        ],
      }),
    );
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);

    await cache.restore();
    expect(storage.values.has("@paseo:replica-cache")).toBe(false);
    await cache.flush();

    expect(useSessionStore.getState().sessions[SERVER_ID]).toBeUndefined();
    expect(JSON.parse(storage.values.get("@paseo:replica-cache") ?? "null")).toEqual({
      version: 9,
      hosts: [],
    });
  });
});
