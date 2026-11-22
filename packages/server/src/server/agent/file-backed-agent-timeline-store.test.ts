import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as nodeFs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("FileBackedAgentTimelineStore compaction (Daseo delta 146)", () => {
  function rowFile(seq: number): string {
    return `${String(seq).padStart(16, "0")}.json`;
  }

  async function seedTimeline(store: FileBackedAgentTimelineStore, count: number): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await store.appendCommitted(
        AGENT_ID,
        index % 2 === 0
          ? { type: "assistant_message", text: `answer ${index}` }
          : { type: "user_message", text: `question ${index}` },
        { timestamp: `2026-11-01T00:00:${String(index).padStart(2, "0")}.000Z` },
      );
    }
  }

  async function snapshot(root: string) {
    const store = new FileBackedAgentTimelineStore(root);
    return {
      rows: await store.getCommittedRows(AGENT_ID),
      fetched: await store.fetchCommitted(AGENT_ID, { direction: "tail", limit: 0 }),
    };
  }

  async function listAgentDir(root: string): Promise<string[]> {
    return (await readdir(path.join(root, AGENT_ID))).sort();
  }

  test("round trip: the same rows, epoch and window from one bundle file", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 6);
    await store.updateCommittedRow(AGENT_ID, {
      ...(await store.getCommittedRows(AGENT_ID))[1]!,
      item: { type: "assistant_message", text: "answer 2", turnOutcome: "completed" },
    });
    const before = await snapshot(root);

    const result = await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID);

    expect(result).toMatchObject({ status: "compacted", rows: 6, looseFilesRemoved: 6 });
    expect(await listAgentDir(root)).toEqual(["rows.jsonl", "state.json"]);
    expect(await snapshot(root)).toEqual(before);
    const lines = (await readFile(path.join(root, AGENT_ID, "rows.jsonl"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("compacting leaves the cache valid and fires no committed-change listener", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 4);
    const before = await store.getCommittedRows(AGENT_ID);
    const changed: string[] = [];
    store.onCommittedChange((agentId) => changed.push(agentId));

    await store.compactTimeline(AGENT_ID);

    expect(changed).toEqual([]);
    expect(await store.getCommittedRows(AGENT_ID)).toEqual(before);
    await store.appendCommitted(AGENT_ID, { type: "user_message", text: "after" });
    expect((await snapshot(root)).rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a loose file overlays its bundled row: an update and an append after bundling", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 4);
    await store.compactTimeline(AGENT_ID);

    const reopened = new FileBackedAgentTimelineStore(root);
    const bundled = (await reopened.getCommittedRows(AGENT_ID))[1]!;
    await reopened.updateCommittedRow(AGENT_ID, {
      ...bundled,
      item: { type: "assistant_message", text: "answer 2", turnOutcome: "completed" },
    });
    const appended = await reopened.appendCommitted(AGENT_ID, {
      type: "user_message",
      text: "continued after unarchive",
    });

    expect(appended.seq).toBe(5);
    expect(await listAgentDir(root)).toEqual([rowFile(2), rowFile(5), "rows.jsonl", "state.json"]);
    const after = await snapshot(root);
    expect(after.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(after.rows[1]?.item).toEqual({
      type: "assistant_message",
      text: "answer 2",
      turnOutcome: "completed",
    });
    expect(after.rows[4]?.item).toEqual({
      type: "user_message",
      text: "continued after unarchive",
    });
  });

  test("crash states load the same rows: temp left behind, bundle plus all or half the loose files", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 6);
    const before = await snapshot(root);
    const directory = path.join(root, AGENT_ID);
    const saved = path.join(root, "saved");
    await mkdir(saved);
    for (let seq = 1; seq <= 6; seq += 1) {
      await copyFile(path.join(directory, rowFile(seq)), path.join(saved, rowFile(seq)));
    }

    // Crash after writing the temp file, before the rename.
    await writeFile(path.join(directory, "rows.jsonl.tmp"), '{"seq":1,"partial');
    expect(await snapshot(root)).toEqual(before);

    await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID);
    expect(await listAgentDir(root)).toEqual(["rows.jsonl", "state.json"]);

    // Crash after the rename, before any unlink: bundle and every loose file.
    for (let seq = 1; seq <= 6; seq += 1) {
      await copyFile(path.join(saved, rowFile(seq)), path.join(directory, rowFile(seq)));
    }
    expect(await snapshot(root)).toEqual(before);

    // Crash halfway through the unlinks.
    for (const seq of [1, 3, 5]) await rm(path.join(directory, rowFile(seq)));
    expect(await snapshot(root)).toEqual(before);

    // The next compaction finishes the job.
    await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID);
    expect(await listAgentDir(root)).toEqual(["rows.jsonl", "state.json"]);
    expect(await snapshot(root)).toEqual(before);
  });

  test("an append queued behind a compaction survives as a loose file", async () => {
    const { root } = await createStore();
    await seedTimeline(new FileBackedAgentTimelineStore(root), 5);
    const store = new FileBackedAgentTimelineStore(root);

    const compaction = store.compactTimeline(AGENT_ID);
    const append = store.appendCommitted(AGENT_ID, { type: "user_message", text: "racing" });
    const [result, appended] = await Promise.all([compaction, append]);

    expect(result).toMatchObject({ status: "compacted", rows: 5, looseFilesRemoved: 5 });
    expect(appended.seq).toBe(6);
    expect(await listAgentDir(root)).toEqual([rowFile(6), "rows.jsonl", "state.json"]);
    const rows = (await snapshot(root)).rows;
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[5]?.item).toEqual({ type: "user_message", text: "racing" });
  });

  test("an uncached load that loses a loose file to a compaction reads it from the bundle", async () => {
    const { root } = await createStore();
    await seedTimeline(new FileBackedAgentTimelineStore(root), 5);
    const before = await snapshot(root);
    const compactor = new FileBackedAgentTimelineStore(root);
    const originalReadFile = nodeFs.promises.readFile;
    let compacted = false;
    const spy = vi
      .spyOn(nodeFs.promises, "readFile")
      .mockImplementation(async (...args: Parameters<typeof originalReadFile>) => {
        if (!compacted && String(args[0]).endsWith(rowFile(3))) {
          compacted = true;
          spy.mockRestore();
          await compactor.compactTimeline(AGENT_ID);
        }
        return originalReadFile(...args);
      });

    const reader = new FileBackedAgentTimelineStore(root);
    const rows = await reader.getCommittedRows(AGENT_ID);

    expect(compacted).toBe(true);
    expect(rows).toEqual(before.rows);
    expect(await listAgentDir(root)).toEqual(["rows.jsonl", "state.json"]);
  });

  test("re-compaction merges the old bundle with rows written after unarchive", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 4);
    await store.compactTimeline(AGENT_ID);
    const reopened = new FileBackedAgentTimelineStore(root);
    await reopened.appendCommitted(AGENT_ID, { type: "user_message", text: "five" });
    await reopened.updateCommittedRow(AGENT_ID, {
      ...(await reopened.getCommittedRows(AGENT_ID))[0]!,
      item: { type: "user_message", text: "question 1 (edited)" },
    });
    const before = await snapshot(root);

    const result = await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID);

    expect(result).toMatchObject({ status: "compacted", rows: 5, looseFilesRemoved: 2 });
    expect(await listAgentDir(root)).toEqual(["rows.jsonl", "state.json"]);
    expect(await snapshot(root)).toEqual(before);
    expect(before.rows[0]?.item).toEqual({ type: "user_message", text: "question 1 (edited)" });
  });

  test("an agent with nothing loose is left alone", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 2);
    await store.compactTimeline(AGENT_ID);
    const bundleBefore = await stat(path.join(root, AGENT_ID, "rows.jsonl"));

    expect(await store.compactTimeline(AGENT_ID)).toEqual({
      status: "skipped",
      reason: "no-loose-rows",
    });
    expect((await stat(path.join(root, AGENT_ID, "rows.jsonl"))).mtimeMs).toBe(
      bundleBefore.mtimeMs,
    );
    expect(await store.compactTimeline("00000000-0000-4000-8000-000000000099")).toEqual({
      status: "skipped",
      reason: "no-timeline",
    });
  });

  test("deleting the timeline removes the bundle and any temp file", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 3);
    await store.compactTimeline(AGENT_ID);
    await writeFile(path.join(root, AGENT_ID, "rows.jsonl.tmp"), "leftover");

    await store.deleteAgent(AGENT_ID);

    await expect(stat(path.join(root, AGENT_ID))).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = new FileBackedAgentTimelineStore(root);
    expect(await fresh.getCommittedRows(AGENT_ID)).toEqual([]);
  });

  test("a lone surrogate in a row survives the bundle", async () => {
    const { root, store } = await createStore();
    const text = "half an emoji \ud83d here";
    await store.appendCommitted(AGENT_ID, { type: "user_message", text });
    await store.appendCommitted(AGENT_ID, { type: "assistant_message", text: "ok" });

    await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID);

    expect(await readFile(path.join(root, AGENT_ID, "rows.jsonl"), "utf8")).toContain("\\ud83d");
    const rows = await new FileBackedAgentTimelineStore(root).getCommittedRows(AGENT_ID);
    expect(rows[0]?.item).toEqual({ type: "user_message", text });
    expect((rows[0]!.item as { text: string }).text.charCodeAt(14)).toBe(0xd83d);
  });

  test("line and paragraph separators inside a row stay inside its line", async () => {
    const { root, store } = await createStore();
    const text = "one\u2028two\u2029three\r\nfour";
    await store.appendCommitted(AGENT_ID, { type: "assistant_message", text });
    await store.appendCommitted(AGENT_ID, { type: "user_message", text: "next" });
    const before = await snapshot(root);

    expect(await new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID)).toMatchObject({
      status: "compacted",
      rows: 2,
    });

    expect(await snapshot(root)).toEqual(before);
    expect(before.rows[0]?.item).toEqual({ type: "assistant_message", text });
  });

  test("a malformed loose file fails the load and the compaction, deleting nothing", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 3);
    await writeFile(path.join(root, AGENT_ID, rowFile(2)), "{ not json");
    const filesBefore = await listAgentDir(root);

    await expect(
      new FileBackedAgentTimelineStore(root).getCommittedRows(AGENT_ID),
    ).rejects.toThrow();
    await expect(
      new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID),
    ).rejects.toThrow();
    expect(await listAgentDir(root)).toEqual(filesBefore);
  });

  test("a malformed bundle line fails the load and the compaction, deleting nothing", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 3);
    await store.compactTimeline(AGENT_ID);
    const bundlePath = path.join(root, AGENT_ID, "rows.jsonl");
    const lines = (await readFile(bundlePath, "utf8")).split("\n");
    lines[1] = '{"seq":2,"timestamp":';
    await writeFile(bundlePath, lines.join("\n"));
    await writeFile(
      path.join(root, AGENT_ID, rowFile(4)),
      JSON.stringify({
        seq: 4,
        timestamp: "2026-11-01T00:00:04.000Z",
        item: { type: "user_message", text: "loose" },
      }),
    );
    const filesBefore = await listAgentDir(root);

    await expect(new FileBackedAgentTimelineStore(root).getCommittedRows(AGENT_ID)).rejects.toThrow(
      "Malformed timeline bundle line 2",
    );
    await expect(new FileBackedAgentTimelineStore(root).compactTimeline(AGENT_ID)).rejects.toThrow(
      "Malformed timeline bundle line 2",
    );
    expect(await listAgentDir(root)).toEqual(filesBefore);
    expect(await readFile(bundlePath, "utf8")).toBe(lines.join("\n"));
  });

  /** How a daemon without delta 146 loads a timeline: numbered files only. */
  async function loadLikeOldDaemon(root: string): Promise<AgentTimelineRow[]> {
    const directory = path.join(root, AGENT_ID);
    const names = (await readdir(directory)).filter((name) => /^\d{16}\.json$/.test(name));
    const rows: AgentTimelineRow[] = [];
    for (const name of names) {
      const row = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as AgentTimelineRow;
      expect(name).toBe(rowFile(row.seq));
      rows.push(row);
    }
    return rows.sort((left, right) => left.seq - right.seq);
  }

  async function readRowFiles(root: string): Promise<Map<string, string>> {
    const directory = path.join(root, AGENT_ID);
    const contents = new Map<string, string>();
    for (const name of await readdir(directory)) {
      if (/^\d{16}\.json$/.test(name)) {
        contents.set(name, await readFile(path.join(directory, name), "utf8"));
      }
    }
    return contents;
  }

  test("expand after compact restores the loose files an older daemon reads, byte for byte", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 6);
    const before = await snapshot(root);
    const filesBefore = await readRowFiles(root);
    await store.compactTimeline(AGENT_ID);

    const result = await new FileBackedAgentTimelineStore(root).expandTimeline(AGENT_ID);

    expect(result).toEqual({ status: "expanded", rows: 6, looseFilesWritten: 6 });
    expect(await listAgentDir(root)).toEqual([...[1, 2, 3, 4, 5, 6].map(rowFile), "state.json"]);
    expect(await readRowFiles(root)).toEqual(filesBefore);
    expect(await loadLikeOldDaemon(root)).toEqual(before.rows);
    expect(await snapshot(root)).toEqual(before);
    expect(await new FileBackedAgentTimelineStore(root).expandTimeline(AGENT_ID)).toEqual({
      status: "skipped",
      reason: "no-bundle",
    });
  });

  test("expand keeps loose overlays and finishes after a crash halfway", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 6);
    await store.compactTimeline(AGENT_ID);
    const reopened = new FileBackedAgentTimelineStore(root);
    await reopened.updateCommittedRow(AGENT_ID, {
      ...(await reopened.getCommittedRows(AGENT_ID))[2]!,
      item: { type: "user_message", text: "question 3 (edited)" },
    });
    await reopened.appendCommitted(AGENT_ID, { type: "assistant_message", text: "seven" });
    const overlay = await readFile(path.join(root, AGENT_ID, rowFile(3)), "utf8");
    const before = await snapshot(root);
    // A crash during an earlier expansion left some loose copies of bundled rows.
    await writeFile(path.join(root, AGENT_ID, rowFile(1)), JSON.stringify(before.rows[0], null, 2));

    const result = await new FileBackedAgentTimelineStore(root).expandTimeline(AGENT_ID);

    expect(result).toEqual({ status: "expanded", rows: 7, looseFilesWritten: 4 });
    expect(await readFile(path.join(root, AGENT_ID, rowFile(3)), "utf8")).toBe(overlay);
    expect(await loadLikeOldDaemon(root)).toEqual(before.rows);
    expect(before.rows[2]?.item).toEqual({ type: "user_message", text: "question 3 (edited)" });
    expect(await listAgentDir(root)).not.toContain("rows.jsonl");
  });

  test("expand of a malformed bundle removes nothing", async () => {
    const { root, store } = await createStore();
    await seedTimeline(store, 3);
    await store.compactTimeline(AGENT_ID);
    const bundlePath = path.join(root, AGENT_ID, "rows.jsonl");
    await writeFile(bundlePath, `${(await readFile(bundlePath, "utf8")).trimEnd()}\n{ broken\n`);
    const filesBefore = await listAgentDir(root);

    await expect(new FileBackedAgentTimelineStore(root).expandTimeline(AGENT_ID)).rejects.toThrow(
      "Malformed timeline bundle line 4",
    );
    expect(await listAgentDir(root)).toEqual(filesBefore);
  });
});
