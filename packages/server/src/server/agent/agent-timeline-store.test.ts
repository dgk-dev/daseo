import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });
  it("closes compaction rows a stopped daemon left open", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 4,
      rows: [
        {
          seq: 1,
          timestamp: "2026-09-15T15:16:57.000Z",
          item: { type: "compaction", status: "loading", trigger: "auto" },
        },
        {
          seq: 2,
          timestamp: "2026-09-16T00:01:04.000Z",
          item: { type: "assistant_message", text: "resumed" },
        },
        {
          seq: 3,
          timestamp: "2026-09-16T00:02:45.000Z",
          item: { type: "compaction", status: "completed", trigger: "auto" },
        },
      ],
    });

    const updated = store.terminalizeOpenCompactions("agent-1", "Compaction was interrupted");

    expect(updated).toEqual([
      {
        seq: 1,
        timestamp: "2026-09-15T15:16:57.000Z",
        item: {
          type: "compaction",
          status: "completed",
          trigger: "auto",
          outcome: "canceled",
          error: "Compaction was interrupted",
        },
      },
    ]);
    expect(store.getItems("agent-1").filter((item) => item.type === "compaction")).toEqual([
      {
        type: "compaction",
        status: "completed",
        trigger: "auto",
        outcome: "canceled",
        error: "Compaction was interrupted",
      },
      { type: "compaction", status: "completed", trigger: "auto" },
    ]);
    expect(store.terminalizeOpenCompactions("agent-1", "Compaction was interrupted")).toEqual([]);
  });

  it("finds only a recent submitted prompt the provider never acknowledged", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 4,
      rows: [
        {
          seq: 1,
          timestamp: "2026-09-02T13:20:00.000Z",
          item: { type: "user_message", text: "continue", clientMessageId: "client-old" },
          providerMessageId: "entry-old",
        },
        {
          seq: 2,
          timestamp: "2026-09-02T13:37:54.000Z",
          item: { type: "user_message", text: "continue", clientMessageId: "client-pending" },
        },
        {
          seq: 3,
          timestamp: "2026-09-02T13:38:00.000Z",
          item: { type: "assistant_message", text: "working" },
        },
      ],
    });

    expect(
      store.findUnacknowledgedSubmittedUserMessage(
        "agent-1",
        "continue",
        new Date("2026-09-02T13:30:00.000Z"),
      ),
    ).toMatchObject({ seq: 2 });
    expect(
      store.findUnacknowledgedSubmittedUserMessage(
        "agent-1",
        "continue",
        new Date("2026-09-02T13:45:00.000Z"),
      ),
    ).toBeNull();
    expect(
      store.findUnacknowledgedSubmittedUserMessage(
        "agent-1",
        "something else",
        new Date("2026-09-02T13:30:00.000Z"),
      ),
    ).toBeNull();
  });
});
