import { expect, test } from "vitest";
import { readPiTranscript } from "./transcript.js";
import { streamPiHistory } from "./history-mapper.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

function decode(entries: unknown[], version = 3) {
  return readPiTranscript(
    [{ type: "session", version }, ...entries].map((entry) => JSON.stringify(entry)).join("\n"),
  );
}

test("restores pre-compaction messages and native IDs without abandoned branches", async () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "question" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer", textSignature: '{"phase":"final_answer"}' }],
      },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "a1",
      message: { role: "user", content: "abandoned" },
    },
    { type: "compaction", id: "c1", parentId: "a1", summary: "summary" },
    { type: "message", id: "u2", parentId: "c1", message: { role: "user", content: "follow up" } },
  ];
  const history = decode(entries);
  expect(history.messages).toEqual([entries[0]!.message, entries[1]!.message, entries[4]!.message]);
  expect(history.userEntries).toEqual([
    { id: "u1", text: "question" },
    { id: "u2", text: "follow up" },
  ]);
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", history.messages, history.userEntries))
    events.push(event);
  expect(events.filter((event) => event.type === "timeline").map((event) => event.item)).toEqual([
    { type: "user_message", text: "question", messageId: "u1" },
    {
      type: "assistant_message",
      text: "answer",
      messageId: "pi-history-assistant-1",
      phase: "final_answer",
    },
    { type: "user_message", text: "follow up", messageId: "u2" },
  ]);
  expect(decode([...entries, { type: "custom", id: "rewind", parentId: null }]).messages).toEqual(
    [],
  );
});

test("preserves custom entries and legacy messages without invented native IDs", () => {
  const custom = {
    type: "custom_message",
    id: "custom",
    parentId: null,
    customType: "notice",
    content: "notice",
    display: true,
    details: { key: 1 },
  };
  expect(decode([custom]).messages).toEqual([{ ...custom, role: "custom" }]);
  expect(decode([{ type: "message", message: { role: "user", content: "legacy" } }], 1)).toEqual({
    messages: [{ role: "user", content: "legacy" }],
    userEntries: [],
  });
});

test.each([
  [{ type: "message", id: "x", parentId: "x", message: { role: "user", content: "cycle" } }],
  [{ type: "message", id: "x", parentId: "missing", message: { role: "user", content: "orphan" } }],
  [
    { type: "custom", id: "x", parentId: null },
    { type: "custom", id: "x", parentId: null },
  ],
  [{ type: "custom", id: "x" }],
])("rejects corrupt ancestry rather than inventing a branch: %j", (...entries) => {
  expect(() => decode(entries)).toThrow();
});

test("traverses private system and summary messages without displaying them", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "private instructions" }] },
    { role: "user", content: "question" },
    { role: "branchSummary", summary: "private branch" },
    { role: "compactionSummary", summary: "private summary" },
    { role: "system", content: null },
  ];
  expect(
    decode(
      messages.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index === 0 ? null : String(index - 1),
        message,
      })),
    ),
  ).toEqual({ messages: [messages[1]], userEntries: [{ id: "1", text: "question" }] });
});

test("keeps reasoning, images, tool outputs and error metadata across compaction", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "inspect" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "consider" },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "a.txt" } },
      ],
      errorMessage: null,
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      details: { count: 1 },
    },
  ];
  expect(
    decode([
      ...messages.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index === 0 ? null : String(index - 1),
        message,
      })),
      { type: "compaction", id: "compact", parentId: "2" },
    ]),
  ).toEqual({ messages, userEntries: [{ id: "0", text: "inspect" }] });
});
