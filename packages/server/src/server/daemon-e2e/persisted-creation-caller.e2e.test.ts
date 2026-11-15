import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./agent-configs.js";

// Upstream #8714: a caller agent that is persisted but not loaded (idle unload, daemon restart)
// still identifies the parent of a child created through the session create path.
test("child creation recognizes a persisted caller that is not loaded", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-persisted-caller-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "test" } });
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    const workspaceId = workspace.workspace?.id;
    expect(workspaceId).toBeTruthy();
    const parent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId,
      title: "Parent",
    });
    await daemon.daemon.agentManager.closeAgent(parent.id);
    expect(daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();

    const child = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      callerAgentId: parent.id,
      title: "Child",
    });
    expect(child.workspaceId).toBe(workspaceId);
    expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("child creation still rejects an archived caller", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-archived-caller-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "test" } });
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    const parent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: workspace.workspace?.id,
      title: "Parent",
    });
    await client.archiveAgent(parent.id);
    expect(daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();

    await expect(
      client.createAgent({ ...getFullAccessConfig("codex"), cwd, callerAgentId: parent.id }),
    ).rejects.toThrow(`Caller agent ${parent.id} not found`);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);
