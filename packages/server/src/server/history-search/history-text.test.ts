import { describe, expect, test } from "vitest";
import { selectEmbeddingChunks, TimelineMessageCollector } from "./history-text.js";

function collect(
  rows: Array<[number, Parameters<TimelineMessageCollector["add"]>[1]]>,
  state = { anchorSeq: null as number | null, tailAssistantSeq: null as number | null },
) {
  const collector = new TimelineMessageCollector(state);
  for (const [seq, item] of rows) collector.add(seq, item);
  return collector.finish();
}

describe("TimelineMessageCollector", () => {
  test("joins an answer streamed as contiguous rows, like the app renders it", () => {
    const result = collect([
      [1, { type: "user_message", text: "전세 대출 조건" }],
      [2, { type: "assistant_message", text: "전액 말소하는 " }],
      [3, { type: "assistant_message", text: "조건을 특약으로" }],
      [
        4,
        {
          type: "tool_call",
          callId: "c",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: {}, output: "" },
        },
      ],
      [5, { type: "assistant_message", text: "Separate answer" }],
    ]);
    expect(result.messages).toEqual([
      { role: "user", text: "전세 대출 조건", seq: 1, anchorSeq: 1 },
      { role: "assistant", text: "전액 말소하는 조건을 특약으로", seq: 2, anchorSeq: 1 },
      { role: "assistant", text: "Separate answer", seq: 5, anchorSeq: 1 },
    ]);
    expect(result.state).toEqual({ anchorSeq: 1, tailAssistantSeq: 5 });
  });

  test("continues the indexed tail across batches and ends the run on any other row", () => {
    const continued = collect(
      [
        [6, { type: "assistant_message", text: " more" }],
        [7, { type: "user_message", text: "next" }],
      ],
      { anchorSeq: 1, tailAssistantSeq: 5 },
    );
    expect(continued.continuationText).toBe(" more");
    expect(continued.messages).toEqual([{ role: "user", text: "next", seq: 7, anchorSeq: 7 }]);
    expect(continued.state).toEqual({ anchorSeq: 7, tailAssistantSeq: null });

    const gap = collect([[8, { type: "assistant_message", text: "new" }]], {
      anchorSeq: 1,
      tailAssistantSeq: 5,
    });
    expect(gap.continuationText).toBeNull();
    expect(gap.messages).toEqual([{ role: "assistant", text: "new", seq: 8, anchorSeq: 1 }]);
  });

  test("skips system prompts and wait-noted replies but opens turns at system rows", () => {
    const result = collect([
      [
        1,
        { type: "user_message", text: "<paseo-system>\nwake\n</paseo-system>", origin: "system" },
      ],
      [2, { type: "assistant_message", text: "[wait " }],
      [3, { type: "assistant_message", text: "noted]" }],
      [4, { type: "reasoning", text: "thinking" }],
      [5, { type: "assistant_message", text: "Report after the wake" }],
    ]);
    expect(result.messages).toEqual([
      { role: "assistant", text: "Report after the wake", seq: 5, anchorSeq: 1 },
    ]);
  });
});

describe("selectEmbeddingChunks", () => {
  test("samples fixed windows evenly and names the message each starts in", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      text: `${String(index).padStart(2, "0")}${"x".repeat(498)}`,
    }));
    const chunks = selectEmbeddingChunks(messages, { chunkChars: 1000, maxChunks: 4 });
    // 30 × 500 chars + 29 separators = 15,058 chars → 16 windows; 4 sampled.
    expect(chunks.map((chunk) => chunk.window)).toEqual([0, 4, 8, 12]);
    expect(chunks[0]?.messageOrdinal).toBe(0);
    expect(chunks[1]?.text.length).toBe(1000);
    // Window 4 starts at offset 4,000; message 7 starts at 7 × 502 = 3,514.
    expect(chunks[1]?.messageOrdinal).toBe(7);
  });
});
