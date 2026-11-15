import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";

let context: DaemonTestContext | undefined;
let root: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await context?.cleanup();
  context = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture() {
  root = mkdtempSync(path.join(tmpdir(), "workspace-archive-restore-"));
  const cwd = path.join(root, "workspace");
  const staticDir = path.join(root, "static");
  mkdirSync(cwd);
  mkdirSync(staticDir);
  const options = {
    paseoHomeRoot: path.join(root, "home"),
    staticDir,
    cleanup: false,
    mcpEnabled: false,
  };
  context = await createDaemonTestContext(options);
  const created = await context.client.createWorkspace({
    source: { kind: "directory", path: cwd },
  });
  const workspaceId = created.workspace!.id;
  const agents = [];
  for (const title of ["A", "B", "individually archived C"]) {
    agents.push(await context.client.createAgent({ provider: "codex", cwd, workspaceId, title }));
  }
  const [a, b, c] = agents;
  if (!a || !b || !c) throw new Error("Expected three agents");
  await context.daemon.daemon.agentManager.archiveAgent(c.id);
  await context.daemon.daemon.agentManager.archiveSnapshot(c.id, "2000-01-01T00:00:00.000Z");
  return { options, workspaceId, a, b, c };
}

async function state(workspaceId: string) {
  if (!context) throw new Error("Missing daemon context");
  const workspaces = await context.client.fetchWorkspaces();
  const agents = await context.daemon.daemon.agentStorage.listByWorkspace(workspaceId);
  return {
    workspaceActive: workspaces.entries.some((workspace) => workspace.id === workspaceId),
    activeAgentIds: agents
      .filter((agent) => !agent.archivedAt)
      .map((agent) => agent.id)
      .sort(),
  };
}

test.each([-1000, 0])(
  "pre-change archives without exact batch membership restore only the workspace (offset %i)",
  async (offset) => {
    const { workspaceId, a, b } = await fixture();
    const response = await context!.client.archiveWorkspace(workspaceId);
    expect(response.error).toBeNull();
    // Old versions had no membership marker. Even coincidentally equal timestamps must not
    // activate their agents; explicit individual archival clears modern provenance too.
    const oldAgentStamp = new Date(Date.parse(response.archivedAt!) + offset).toISOString();
    await context!.daemon.daemon.agentManager.archiveSnapshot(a.id, oldAgentStamp);
    await context!.daemon.daemon.agentManager.archiveSnapshot(b.id, oldAgentStamp);
    await context!.client.restoreWorkspace(workspaceId);
    expect(await state(workspaceId)).toEqual({ workspaceActive: true, activeAgentIds: [] });
  },
  30000,
);

test("unarchiving restores exactly the two agents archived with the workspace, after restart", async () => {
  const { options, workspaceId, a, b, c } = await fixture();
  const archived = await context!.client.archiveWorkspace(workspaceId);
  expect(archived.error).toBeNull();
  expect(await state(workspaceId)).toEqual({ workspaceActive: false, activeAgentIds: [] });
  await context!.cleanup();
  context = undefined;
  context = await createDaemonTestContext(options);
  await context.client.restoreWorkspace(workspaceId);
  expect(await state(workspaceId)).toEqual({
    workspaceActive: true,
    activeAgentIds: [a.id, b.id].sort(),
  });
  expect((await context.daemon.daemon.agentStorage.get(c.id))?.archivedAt).toBe(
    "2000-01-01T00:00:00.000Z",
  );
}, 30000);

test.each([0, 1000])(
  "an agent individually archived after the workspace archive stays archived (offset %i)",
  async (offset) => {
    const { workspaceId, a, b } = await fixture();
    const archived = await context!.client.archiveWorkspace(workspaceId);
    expect(archived.error).toBeNull();
    const laterStamp = new Date(Date.parse(archived.archivedAt!) + offset).toISOString();
    await context!.daemon.daemon.agentManager.archiveSnapshot(a.id, laterStamp);
    await context!.client.restoreWorkspace(workspaceId);
    expect(await state(workspaceId)).toEqual({ workspaceActive: true, activeAgentIds: [b.id] });
    expect((await context!.daemon.daemon.agentStorage.get(a.id))?.archivedAt).toBe(laterStamp);
  },
  30000,
);

test("individual archive in the same millisecond before workspace archive is not batch membership", async () => {
  const { workspaceId, a, b, c } = await fixture();
  const timestamp = "2026-11-15T10:00:00.000Z";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(timestamp));
  await context!.daemon.daemon.agentManager.archiveSnapshot(c.id, timestamp);
  const archived = await context!.client.archiveWorkspace(workspaceId);
  expect(archived.error).toBeNull();
  expect(archived.archivedAt).toBe(timestamp);
  await context!.client.restoreWorkspace(workspaceId);
  expect(await state(workspaceId)).toEqual({
    workspaceActive: true,
    activeAgentIds: [a.id, b.id].sort(),
  });
  expect((await context!.daemon.daemon.agentStorage.get(c.id))?.archivedAt).toBe(timestamp);
}, 30000);

test("an individual archive that supersedes a listed batch candidate is rechecked before native unarchive", async () => {
  const { workspaceId, a, b } = await fixture();
  const archived = await context!.client.archiveWorkspace(workspaceId);
  expect(archived.error).toBeNull();
  const storage = context!.daemon.daemon.agentStorage;
  const originalList = storage.listByWorkspace.bind(storage);
  const list = vi.spyOn(storage, "listByWorkspace").mockImplementationOnce(async (id) => {
    const staleCandidates = await originalList(id);
    await context!.daemon.daemon.agentManager.archiveSnapshot(a.id, archived.archivedAt!);
    return staleCandidates;
  });
  try {
    await context!.client.restoreWorkspace(workspaceId);
    expect(await state(workspaceId)).toEqual({ workspaceActive: true, activeAgentIds: [b.id] });
    expect((await storage.get(a.id))?.archivedAt).toBe(archived.archivedAt);
  } finally {
    list.mockRestore();
  }
}, 30000);

test("stored-only agents and parent-child cascades retain exact workspace batch membership", async () => {
  const { workspaceId, a, b, c } = await fixture();
  await context!.daemon.daemon.agentManager.updateAgentMetadata(b.id, {
    labels: { "paseo.parent-agent-id": a.id },
  });
  await context!.daemon.daemon.agentManager.closeAgent(a.id);
  await context!.daemon.daemon.agentManager.closeAgent(b.id);
  const archived = await context!.client.archiveWorkspace(workspaceId);
  expect(archived.error).toBeNull();
  for (const id of [a.id, b.id]) {
    const record = await context!.daemon.daemon.agentStorage.get(id);
    expect(record?.workspaceArchiveAt).toBe(archived.archivedAt);
  }
  await context!.client.restoreWorkspace(workspaceId);
  expect(await state(workspaceId)).toEqual({
    workspaceActive: true,
    activeAgentIds: [a.id, b.id].sort(),
  });
  expect((await context!.daemon.daemon.agentStorage.get(c.id))?.archivedAt).toBe(
    "2000-01-01T00:00:00.000Z",
  );
}, 30000);
