import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HistoryIndexStore } from "./history-index-store.js";

const roots: string[] = [];
const stores: HistoryIndexStore[] = [];

async function openStore(file?: string): Promise<{ store: HistoryIndexStore; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-history-index-"));
  roots.push(root);
  const target = file ?? path.join(root, "search", "history-index.sqlite");
  const store = await HistoryIndexStore.open(target);
  stores.push(store);
  return { store, file: target };
}

function seed(store: HistoryIndexStore, agentId: string, texts: string[]): void {
  store.replaceSession({
    session: {
      agentId,
      source: "timeline",
      sourceMark: "epoch-1",
      indexedSeq: texts.length,
      lastAnchorSeq: 1,
      tailAssistantSeq: null,
    },
    messages: texts.map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text,
      seq: index + 1,
      anchorSeq: 1,
    })),
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HistoryIndexStore", () => {
  test("matches a Korean word inside an inflected one, and a 2-syllable word", async () => {
    const { store } = await openStore();
    seed(store, "a", ["세금계산서 발행 규칙을 정리했다", "다음 달 10일까지 발행합니다"]);
    seed(store, "b", ["Railway 보안 사고 대응", "keys rotated"]);

    // Three or more characters go through the trigram index.
    expect(store.countMatchingMessages("세금계산서")).toEqual(new Map([["a", 1]]));
    // Two characters cannot be trigram-matched; the LIKE fallback finds them.
    expect(store.countMatchingMessages("규칙")).toEqual(new Map([["a", 1]]));
    expect(store.countMatchingMessages("발행")).toEqual(new Map([["a", 2]]));
    expect(store.countMatchingMessages("보안")).toEqual(new Map([["b", 1]]));
    // ASCII matching ignores case either way.
    expect(store.countMatchingMessages("railway")).toEqual(new Map([["b", 1]]));
    expect(store.countMatchingMessages("KEYS")).toEqual(new Map([["b", 1]]));
  });

  test("treats LIKE wildcards and FTS syntax in a query as plain text", async () => {
    const { store } = await openStore();
    seed(store, "a", ["100% done", 'said "quoted" words', "a_b"]);
    seed(store, "b", ["1000 done", "ab"]);

    expect(store.countMatchingMessages("0%")).toEqual(new Map([["a", 1]]));
    expect(store.countMatchingMessages("a_")).toEqual(new Map([["a", 1]]));
    expect(store.countMatchingMessages('"quoted"')).toEqual(new Map([["a", 1]]));
    expect(store.countMatchingMessages("NEAR(")).toEqual(new Map());
  });

  test("appends to a session and keeps message order and counts", async () => {
    const { store } = await openStore();
    seed(store, "a", ["first"]);
    store.appendMessages({
      agentId: "a",
      indexedSeq: 9,
      lastAnchorSeq: 8,
      tailAssistantSeq: 9,
      continuationText: null,
      messages: [{ role: "assistant", text: "second answer", seq: 9, anchorSeq: 8 }],
    });

    expect(store.listMessages("a").map((message) => [message.ordinal, message.text])).toEqual([
      [0, "first"],
      [1, "second answer"],
    ]);
    expect(store.getSession("a")).toMatchObject({
      indexedSeq: 9,
      lastAnchorSeq: 8,
      messageCount: 2,
      textChars: "first".length + "second answer".length,
    });
    expect(store.getLastMessage("a", "assistant")?.text).toBe("second answer");
    expect(store.countMatchingMessages("second")).toEqual(new Map([["a", 1]]));
  });

  test("continues the last message when an answer streamed across batches", async () => {
    const { store } = await openStore();
    seed(store, "a", ["question", "the answer beg"]);
    store.appendMessages({
      agentId: "a",
      indexedSeq: 4,
      lastAnchorSeq: 1,
      tailAssistantSeq: 4,
      continuationText: "ins here",
      messages: [],
    });

    expect(store.listMessages("a").map((message) => message.text)).toEqual([
      "question",
      "the answer begins here",
    ]);
    expect(store.getSession("a")).toMatchObject({
      messageCount: 2,
      textChars: "question".length + "the answer begins here".length,
      tailAssistantSeq: 4,
    });
    // The full-text index follows the updated text.
    expect(store.countMatchingMessages("begins")).toEqual(new Map([["a", 1]]));
    expect(store.countMatchingMessages("answer beg")).toEqual(new Map([["a", 1]]));
  });

  test("deleting a session removes its text from search and its vectors", async () => {
    const { store } = await openStore();
    seed(store, "a", ["unique phrase here"]);
    const messageId = store.listMessages("a")[0]?.id ?? 0;
    store.replaceChunks({
      agentId: "a",
      chunks: [{ window: 0, messageId, textHash: "h", vector: new Float32Array([0.6, 0.8]) }],
      embeddedChars: 18,
      model: "test-model",
    });
    expect(store.listAllChunks()[0]?.vector).toEqual(new Float32Array([0.6, 0.8]));
    expect(store.getSession("a")).toMatchObject({ embeddedChars: 18, embeddedModel: "test-model" });

    store.deleteSession("a");

    expect(store.getSession("a")).toBeNull();
    expect(store.countMatchingMessages("unique")).toEqual(new Map());
    expect(store.listAllChunks()).toEqual([]);
  });

  test("keeps the index across reopen and rebuilds an unreadable file", async () => {
    const { store, file } = await openStore();
    seed(store, "a", ["persisted text"]);
    store.close();

    const reopened = await HistoryIndexStore.open(file);
    stores.push(reopened);
    expect(reopened.getSession("a")?.messageCount).toBe(1);
    reopened.close();

    await writeFile(file, "not a database");
    const rebuilt = await HistoryIndexStore.open(file);
    stores.push(rebuilt);
    expect(rebuilt.listSessions()).toEqual([]);
    seed(rebuilt, "b", ["fresh"]);
    expect(rebuilt.countMatchingMessages("fresh")).toEqual(new Map([["b", 1]]));
  });
});
