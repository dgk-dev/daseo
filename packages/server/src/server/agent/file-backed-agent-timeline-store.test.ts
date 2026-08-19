import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileBackedAgentTimelineStore } from "./file-backed-agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000041";
const roots: string[] = [];

async function createStore(): Promise<{ root: string; store: FileBackedAgentTimelineStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-timeline-store-"));
  roots.push(root);
  return { root, store: new FileBackedAgentTimelineStore(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileBackedAgentTimelineStore", () => {
  test("preserves canonical assistant outcomes and cursor identity across process reload", async () => {
    const { root, store } = await createStore();
    const empty = await store.fetchCommitted(AGENT_ID, { direction: "tail", limit: 0 });
    const row: AgentTimelineRow = {
      seq: 1,
      timestamp: "2026-08-19T00:00:00.000Z",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "Long final answer" },
    };

    await store.bulkInsert(AGENT_ID, [row]);
    await store.updateCommittedRow(AGENT_ID, {
      ...row,
      item: { ...row.item, turnOutcome: "completed" },
    });

    const reloaded = new FileBackedAgentTimelineStore(root);
    const fetched = await reloaded.fetchCommitted(AGENT_ID, { direction: "tail", limit: 0 });

    expect(fetched.epoch).toBe(empty.epoch);
    expect(fetched.window).toEqual({ minSeq: 1, maxSeq: 1, nextSeq: 2 });
    expect(fetched.rows).toEqual([
      {
        ...row,
        item: { ...row.item, turnOutcome: "completed" },
      },
    ]);
    expect(await reloaded.getLastAssistantMessage(AGENT_ID)).toBe("Long final answer");

    if (process.platform !== "win32") {
      expect((await stat(path.join(root, AGENT_ID))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, AGENT_ID, "0000000000000001.json"))).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(
      JSON.parse(await readFile(path.join(root, AGENT_ID, "state.json"), "utf8")),
    ).toMatchObject({ version: 1, epoch: empty.epoch, nextSeq: 2 });
  });

  test("rejects filesystem-shaped agent ids before accessing storage", async () => {
    const { store } = await createStore();
    await expect(store.getCommittedRows("../../outside")).rejects.toThrow(
      "Unsafe agent timeline id",
    );
  });
});
