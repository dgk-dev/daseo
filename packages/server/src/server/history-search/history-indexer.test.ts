import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { HistoryIndexStore } from "./history-index-store.js";
import { HistoryIndexer, type IndexableAgent } from "./history-indexer.js";
import {
  REASONING_ONLY_WORD,
  SYSTEM_ONLY_WORD,
  TOOL_ONLY_WORD,
  writeFixtureTimelines,
} from "./test-utils/write-history-fixture.js";

const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup(roots: IndexableAgent[]) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-history-indexer-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const timelinesDir = path.join(home, "timelines");
  const store = await HistoryIndexStore.open(path.join(home, "search", "index.sqlite"));
  cleanups.push(() => store.close());
  const known = new Map(roots.map((agent) => [agent.id, agent]));
  const changed: string[] = [];
  const indexer = new HistoryIndexer({
    store,
    timelinesDir,
    listRootAgents: async () => [...known.values()],
    resolveRootAgent: async (agentId) => known.get(agentId) ?? null,
    logger,
    onSessionChanged: (agentId) => changed.push(agentId),
    debounceMs: 5,
  });
  cleanups.push(() => indexer.stop());
  return { home, timelinesDir, store, indexer, known, changed };
}

function piLine(entry: unknown): string {
  return JSON.stringify(entry);
}

describe("HistoryIndexer", () => {
  test("indexes owner messages and answers only, with the row to open at", async () => {
    const { timelinesDir, store, indexer } = await setup([{ id: "root", piSessionFile: null }]);
    await writeFixtureTimelines({
      timelinesDir,
      sessions: [
        {
          id: "root",
          title: "t",
          messages: [
            { role: "user", text: "rotate the railway keys" },
            { role: "assistant", text: "Rotated all railway keys." },
          ],
        },
      ],
    });

    await indexer.start();

    const messages = store.listMessages("root");
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "rotate the railway keys"],
      ["assistant", "Rotated all railway keys."],
    ]);
    // Rows: 1 system prompt, 2 user, 3 reasoning, 4 tool call, 5 assistant.
    expect(messages.map((message) => [message.seq, message.anchorSeq])).toEqual([
      [2, 2],
      [5, 2],
    ]);
    for (const word of [TOOL_ONLY_WORD, REASONING_ONLY_WORD, SYSTEM_ONLY_WORD]) {
      expect(store.countMatchingMessages(word)).toEqual(new Map());
    }
    expect(indexer.status()).toEqual({ state: "ready", indexedSessions: 1, totalSessions: 1 });
  });

  test("leaves out sessions that are not History roots and drops ones that stop being roots", async () => {
    const { timelinesDir, store, indexer, known } = await setup([
      { id: "root", piSessionFile: null },
    ]);
    const timelines = await writeFixtureTimelines({
      timelinesDir,
      sessions: [
        { id: "root", title: "t", messages: [{ role: "user", text: "root words" }] },
        { id: "worker", title: "t", messages: [{ role: "user", text: "worker words" }] },
      ],
    });
    await indexer.start();
    expect(store.getSession("worker")).toBeNull();

    // A sub-agent's later rows never reach the index either.
    timelines.onCommittedChange((agentId) => indexer.notifyTimelineChanged(agentId));
    await timelines.appendCommitted("worker", { type: "user_message", text: "more worker words" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexer.idle();
    expect(store.countMatchingMessages("worker")).toEqual(new Map());

    // Deleting the root removes it on its next change.
    known.delete("root");
    await timelines.deleteAgent("root");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexer.idle();
    expect(store.getSession("root")).toBeNull();
  });

  test("appends only new rows on a timeline change and re-reads a reset timeline", async () => {
    const { timelinesDir, store, indexer, changed } = await setup([
      { id: "root", piSessionFile: null },
    ]);
    const timelines = await writeFixtureTimelines({
      timelinesDir,
      sessions: [{ id: "root", title: "t", messages: [{ role: "user", text: "first prompt" }] }],
    });
    timelines.onCommittedChange((agentId) => indexer.notifyTimelineChanged(agentId));
    await indexer.start();
    const firstIds = store.listMessages("root").map((message) => message.id);

    await timelines.appendCommitted("root", { type: "assistant_message", text: "an answer" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexer.idle();
    const appended = store.listMessages("root");
    expect(appended.map((message) => message.text)).toEqual(["first prompt", "an answer"]);
    // The first message kept its row: nothing was re-read.
    expect(appended[0]?.id).toBe(firstIds[0]);
    expect(appended[1]).toMatchObject({ seq: 5, anchorSeq: 2 });
    expect(changed).toContain("root");

    // A rehydrate deletes the timeline and writes it again under a new epoch.
    await timelines.deleteAgent("root");
    await timelines.appendCommitted("root", { type: "user_message", text: "rehydrated prompt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await indexer.idle();
    expect(store.listMessages("root").map((message) => [message.text, message.seq])).toEqual([
      ["rehydrated prompt", 1],
    ]);
  });

  test("reads a session that exists only as a Pi session file", async () => {
    const { home, store, indexer } = await setup([]);
    const sessionFile = path.join(home, "pi", "2026-08-14T02-42-59-581Z_x.jsonl");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.dirname(sessionFile), { recursive: true }),
    );
    await writeFile(
      sessionFile,
      [
        piLine({ type: "session", version: 3, id: "x", cwd: "/tmp" }),
        piLine({
          type: "message",
          id: "1",
          message: { role: "user", content: [{ type: "text", text: "카메라 앱 규칙 정리" }] },
        }),
        piLine({
          type: "message",
          id: "2",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: REASONING_ONLY_WORD },
              { type: "text", text: "규칙을 세 가지로 정리했습니다." },
            ],
          },
        }),
        piLine({
          type: "message",
          id: "3",
          message: {
            role: "toolResult",
            toolCallId: "t",
            toolName: "bash",
            content: [{ type: "text", text: TOOL_ONLY_WORD }],
          },
        }),
        piLine({
          type: "message",
          id: "4",
          message: {
            role: "user",
            content: `<paseo-system>\nwake ${SYSTEM_ONLY_WORD}\n</paseo-system>`,
          },
        }),
        "",
      ].join("\n"),
    );
    const restored = new HistoryIndexer({
      store,
      timelinesDir: path.join(home, "timelines"),
      listRootAgents: async () => [{ id: "legacy", piSessionFile: sessionFile }],
      resolveRootAgent: async () => ({ id: "legacy", piSessionFile: sessionFile }),
      logger,
    });
    cleanups.push(() => restored.stop());
    indexer.stop();

    await restored.start();

    expect(
      store.listMessages("legacy").map((message) => [message.role, message.text, message.seq]),
    ).toEqual([
      ["user", "카메라 앱 규칙 정리", null],
      ["assistant", "규칙을 세 가지로 정리했습니다.", null],
    ]);
    expect(store.getSession("legacy")?.source).toBe("pi-file");
    for (const word of [TOOL_ONLY_WORD, REASONING_ONLY_WORD, SYSTEM_ONLY_WORD]) {
      expect(store.countMatchingMessages(word)).toEqual(new Map());
    }
  });

  test("counts a root with no readable text as indexed", async () => {
    const { indexer, store } = await setup([{ id: "empty", piSessionFile: null }]);
    await indexer.start();
    expect(store.getSession("empty")?.source).toBe("none");
    expect(indexer.status()).toEqual({ state: "ready", indexedSessions: 1, totalSessions: 1 });
  });
});
