import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { FileBackedAgentTimelineStore } from "./file-backed-agent-timeline-store.js";
import {
  type CompactionAgentRecord,
  TimelineCompactionSweeper,
  type TimelineCompactionSettings,
} from "./timeline-compaction-sweeper.js";

const logger = pino({ level: "silent" });
const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

async function setup(input: {
  agents: Array<{ record: CompactionAgentRecord; rows: number }>;
  loaded?: string[];
  settings: TimelineCompactionSettings;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-timeline-compaction-"));
  roots.push(root);
  const writer = new FileBackedAgentTimelineStore(root);
  for (const agent of input.agents) {
    for (let index = 0; index < agent.rows; index += 1) {
      await writer.appendCommitted(agent.record.id, { type: "user_message", text: `m${index}` });
    }
  }
  const records = new Map(input.agents.map((agent) => [agent.record.id, agent.record]));
  const loaded = new Set(input.loaded ?? []);
  const sweeper = new TimelineCompactionSweeper({
    store: new FileBackedAgentTimelineStore(root),
    timelinesDir: root,
    listAgentRecords: async () => [...records.values()],
    getAgentRecord: async (agentId) => records.get(agentId) ?? null,
    isAgentLoaded: (agentId) => loaded.has(agentId),
    settings: input.settings,
    logger,
    now: () => NOW,
    pauseBetweenAgentsMs: 0,
  });
  return { root, sweeper };
}

async function files(root: string, agentId: string): Promise<string[]> {
  return (await readdir(path.join(root, agentId))).sort();
}

const COMPACT: TimelineCompactionSettings = {
  mode: "compact",
  maxAgentsPerRun: 100,
  intervalMs: null,
};

describe("TimelineCompactionSweeper", () => {
  test("compacts only agents archived a week ago that are not loaded and have loose rows", async () => {
    const { root, sweeper } = await setup({
      agents: [
        { record: { id: "eligible", archivedAt: daysAgo(10) }, rows: 3 },
        { record: { id: "not-archived", archivedAt: null }, rows: 3 },
        { record: { id: "no-archive-field" }, rows: 3 },
        { record: { id: "archived-recently", archivedAt: daysAgo(3) }, rows: 3 },
        { record: { id: "loaded", archivedAt: daysAgo(10) }, rows: 3 },
        { record: { id: "one-row", archivedAt: daysAgo(10) }, rows: 1 },
      ],
      loaded: ["loaded"],
      settings: COMPACT,
    });

    const summary = await sweeper.runOnce();

    expect(summary).toMatchObject({
      mode: "compact",
      agents: 1,
      failed: 0,
      looseFiles: 3,
      rows: 3,
    });
    expect(summary.allocatedBytesBefore).toBeGreaterThan(summary.allocatedBytesAfter);
    expect(await files(root, "eligible")).toEqual(["rows.jsonl", "state.json"]);
    for (const agentId of ["not-archived", "no-archive-field", "archived-recently", "loaded"]) {
      expect(await files(root, agentId)).toContain("0000000000000001.json");
      expect(await files(root, agentId)).not.toContain("rows.jsonl");
    }
    expect(await files(root, "one-row")).toEqual(["0000000000000001.json", "state.json"]);
  });

  test("stops after the per-run cap, oldest archive first", async () => {
    const { root, sweeper } = await setup({
      agents: [
        { record: { id: "newer", archivedAt: daysAgo(8) }, rows: 2 },
        { record: { id: "oldest", archivedAt: daysAgo(30) }, rows: 2 },
        { record: { id: "middle", archivedAt: daysAgo(20) }, rows: 2 },
      ],
      settings: { ...COMPACT, maxAgentsPerRun: 2 },
    });

    expect(await sweeper.runOnce()).toMatchObject({ agents: 2 });
    expect(await files(root, "oldest")).toContain("rows.jsonl");
    expect(await files(root, "middle")).toContain("rows.jsonl");
    expect(await files(root, "newer")).not.toContain("rows.jsonl");

    expect(await sweeper.runOnce()).toMatchObject({ agents: 1 });
    expect(await files(root, "newer")).toContain("rows.jsonl");
  });

  test("a dry run reports what it would compact and changes nothing", async () => {
    const { root, sweeper } = await setup({
      agents: [
        { record: { id: "a", archivedAt: daysAgo(10) }, rows: 4 },
        { record: { id: "b", archivedAt: daysAgo(9) }, rows: 2 },
      ],
      settings: { mode: "dry-run", maxAgentsPerRun: 100, intervalMs: null },
    });
    const before = { a: await files(root, "a"), b: await files(root, "b") };

    const summary = await sweeper.runOnce();

    expect(summary).toMatchObject({
      mode: "dry-run",
      agents: 2,
      looseFiles: 6,
      allocatedBytesAfter: 0,
    });
    expect(summary.allocatedBytesBefore).toBeGreaterThan(0);
    expect({ a: await files(root, "a"), b: await files(root, "b") }).toEqual(before);
  });

  test("an agent that does not load cleanly is counted as failed and left as it is", async () => {
    const { root, sweeper } = await setup({
      agents: [
        { record: { id: "broken", archivedAt: daysAgo(10) }, rows: 3 },
        { record: { id: "fine", archivedAt: daysAgo(9) }, rows: 2 },
      ],
      settings: COMPACT,
    });
    await writeFile(path.join(root, "broken", "0000000000000002.json"), "{ broken");
    const before = await files(root, "broken");

    expect(await sweeper.runOnce()).toMatchObject({ agents: 1, failed: 1 });
    expect(await files(root, "broken")).toEqual(before);
    expect(await files(root, "fine")).toEqual(["rows.jsonl", "state.json"]);
  });
});
