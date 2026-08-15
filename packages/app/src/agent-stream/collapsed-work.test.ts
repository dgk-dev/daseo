import { describe, expect, test } from "vitest";
import type { StreamItem } from "@/types/stream";
import { collapseCompletedWork, collapseCompletedWorkStream } from "./collapsed-work";

let sequence = 0;
function item(kind: StreamItem["kind"], id?: string): StreamItem {
  sequence += 1;
  return {
    kind,
    id: id ?? `${kind}_${sequence}`,
    text: "x",
    timestamp: new Date(1_700_000_000_000 + sequence * 1000),
  } as StreamItem;
}

const NONE: ReadonlySet<string> = new Set();

describe("collapseCompletedWork", () => {
  test("hides work items of completed turns and keeps messages", () => {
    const items = [
      item("user_message"),
      item("thought"),
      item("tool_call"),
      item("assistant_message", "a1"),
      item("user_message"),
      item("tool_call"),
      item("assistant_message", "a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(result.workCountByTurnKey.get("a1")).toBe(2);
    expect(result.workCountByTurnKey.get("a2")).toBe(1);
  });

  test("keeps the trailing turn visible while a turn is active", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message", "a1"),
      item("user_message"),
      item("tool_call"),
      item("assistant_message", "a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: true,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "tool_call",
      "assistant_message",
    ]);
  });

  test("keeps turns without an assistant message untouched", () => {
    const items = [item("user_message"), item("tool_call"), item("thought")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toHaveLength(3);
    expect(result.workCountByTurnKey.size).toBe(0);
  });

  test("expanded turns keep their work items", () => {
    const items = [
      item("user_message"),
      item("tool_call"),
      item("assistant_message", "a1"),
      item("user_message"),
      item("tool_call"),
      item("assistant_message", "a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: new Set(["a1"]),
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "tool_call",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test("collapses a leading partial turn that already has its assistant message", () => {
    const items = [
      item("tool_call"),
      item("assistant_message", "a0"),
      item("user_message"),
      item("thought"),
      item("assistant_message", "a1"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
  });

  test("keeps compaction markers visible", () => {
    const items = [
      item("user_message"),
      item("compaction"),
      item("tool_call"),
      item("assistant_message", "a1"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "compaction",
      "assistant_message",
    ]);
  });

  test("returns the identical array when nothing collapses", () => {
    const items = [item("user_message"), item("assistant_message", "a1")];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.items).toBe(items);
  });

  test("counts multi-message turns against the last assistant message", () => {
    const items = [
      item("user_message"),
      item("assistant_message", "a1"),
      item("tool_call"),
      item("assistant_message", "a2"),
    ];
    const result = collapseCompletedWork({
      items,
      expandedTurnKeys: NONE,
      keepLastTurnExpanded: false,
    });
    expect(result.workCountByTurnKey.has("a1")).toBe(false);
    expect(result.workCountByTurnKey.get("a2")).toBe(1);
    expect(result.items.map((entry) => entry.kind)).toEqual([
      "user_message",
      "assistant_message",
      "assistant_message",
    ]);
  });
});

describe("collapseCompletedWorkStream", () => {
  test("folds a turn spanning the tail/head boundary into one summary", () => {
    const user = item("user_message");
    const settledWork = item("tool_call");
    const headWork = item("thought");
    const finalAssistant = item("assistant_message", "a-final");
    const result = collapseCompletedWorkStream({
      tail: [user, settledWork],
      head: [headWork, finalAssistant],
      expandedTurnKeys: NONE,
      isTurnActive: false,
    });
    expect(result.tail).toEqual([user]);
    expect(result.head).toEqual([finalAssistant]);
    expect(result.workCountByTurnKey.size).toBe(1);
    expect(result.workCountByTurnKey.get("a-final")).toBe(2);
  });

  test("leaves the streaming head untouched while a turn is active", () => {
    const tail = [item("user_message"), item("tool_call"), item("assistant_message", "a1")];
    const head = [item("tool_call"), item("thought")];
    const result = collapseCompletedWorkStream({
      tail,
      head,
      expandedTurnKeys: NONE,
      isTurnActive: true,
    });
    expect(result.head).toBe(head);
    // Trailing tail turn stays expanded defensively during an active turn.
    expect(result.tail).toBe(tail);
  });

  test("collapses an idle head-only completed turn immediately", () => {
    const head = [item("user_message"), item("tool_call"), item("assistant_message", "a1")];
    const result = collapseCompletedWorkStream({
      tail: [],
      head,
      expandedTurnKeys: NONE,
      isTurnActive: false,
    });
    expect(result.head.map((entry) => entry.kind)).toEqual(["user_message", "assistant_message"]);
    expect(result.workCountByTurnKey.get("a1")).toBe(1);
  });

  test("expanding the spanning turn restores items on both sides", () => {
    const user = item("user_message");
    const settledWork = item("tool_call");
    const headWork = item("thought");
    const finalAssistant = item("assistant_message", "a-final");
    const result = collapseCompletedWorkStream({
      tail: [user, settledWork],
      head: [headWork, finalAssistant],
      expandedTurnKeys: new Set(["a-final"]),
      isTurnActive: false,
    });
    expect(result.tail).toEqual([user, settledWork]);
    expect(result.head).toEqual([headWork, finalAssistant]);
  });
});
