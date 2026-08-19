import { describe, expect, test } from "vitest";
import type { AgentProvider, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { applyStreamEvent, type StreamItem } from "@/types/stream";
import { collapseCompletedWork, collapseCompletedWorkStream } from "./collapsed-work";

interface ProviderEvent {
  event: AgentStreamEventPayload;
  timestamp: Date;
}

function timeline(
  provider: AgentProvider,
  item: Extract<AgentStreamEventPayload, { type: "timeline" }>["item"],
  seconds: number,
): ProviderEvent {
  return {
    event: { type: "timeline", provider, item },
    timestamp: new Date(1_723_860_000_000 + seconds * 1000),
  };
}

function toolItem(input: {
  callId: string;
  status: "completed" | "failed";
}): Extract<AgentStreamEventPayload, { type: "timeline" }>["item"] {
  const detail: ToolCallDetail = {
    type: "unknown",
    input: { command: "inspect" },
    output: input.status === "completed" ? "ok" : null,
  };
  return input.status === "completed"
    ? {
        type: "tool_call",
        callId: input.callId,
        name: "shell",
        status: "completed",
        error: null,
        detail,
      }
    : {
        type: "tool_call",
        callId: input.callId,
        name: "shell",
        status: "failed",
        error: { message: "failed" },
        detail,
      };
}

function terminal(
  provider: AgentProvider,
  event:
    | { type: "turn_completed" }
    | { type: "turn_failed"; error: string }
    | { type: "turn_canceled"; reason: string },
  seconds: number,
): ProviderEvent {
  return {
    event: { ...event, provider },
    timestamp: new Date(1_723_860_000_000 + seconds * 1000),
  };
}

function reduceProviderEvents(events: readonly ProviderEvent[]): {
  tail: StreamItem[];
  head: StreamItem[];
} {
  let tail: StreamItem[] = [];
  let head: StreamItem[] = [];
  for (const update of events) {
    const next = applyStreamEvent({ tail, head, ...update });
    tail = next.tail;
    head = next.head;
  }
  return { tail, head };
}

function assistantTexts(items: readonly StreamItem[]): string[] {
  return items.flatMap((item) => (item.kind === "assistant_message" ? [item.text] : []));
}

function collapseIdle(items: StreamItem[]) {
  return collapseCompletedWork({
    items,
    expandedTurnKeys: new Set(),
    keepLastTurnExpanded: false,
  });
}

describe("completed-work provider event matrix", () => {
  test("Codex reuses a message id around tools without losing split final blocks", () => {
    const provider = "codex";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Inspect", messageId: "user-codex" }, 0),
      timeline(
        provider,
        { type: "assistant_message", text: "I will inspect.", messageId: "assistant-shared" },
        1,
      ),
      timeline(provider, toolItem({ callId: "codex-tool", status: "completed" }), 2),
      timeline(
        provider,
        {
          type: "assistant_message",
          text: "Final section one.\n\nFinal section two.",
          messageId: "assistant-shared",
        },
        3,
      ),
      terminal(provider, { type: "turn_completed" }, 4),
    ]);
    const collapsed = collapseIdle(reduced.tail);

    expect(reduced.head).toEqual([]);
    expect(assistantTexts(collapsed.items)).toEqual(["Final section one.", "Final section two."]);
    expect(collapsed.items.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "assistant_message",
    ]);
    const turnKey = [...collapsed.workCountByTurnKey.keys()][0];
    expect(collapsed.workCountByTurnKey.get(turnKey)).toBe(2);

    const expanded = collapseCompletedWork({
      items: reduced.tail,
      expandedTurnKeys: new Set([turnKey!]),
      keepLastTurnExpanded: false,
    });
    expect(expanded.items).toBe(reduced.tail);
  });

  test("Claude-style idless chunks merge before completed work folds", () => {
    const provider = "claude";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Fix it", messageId: "user-claude" }, 0),
      timeline(provider, { type: "reasoning", text: "Reasoning" }, 1),
      timeline(provider, toolItem({ callId: "claude-tool", status: "completed" }), 2),
      timeline(provider, { type: "assistant_message", text: "The result" }, 3),
      timeline(provider, { type: "assistant_message", text: " is ready." }, 4),
      terminal(provider, { type: "turn_completed" }, 5),
    ]);
    const collapsed = collapseIdle(reduced.tail);

    expect(assistantTexts(collapsed.items)).toEqual(["The result is ready."]);
    expect(collapsed.items.map((item) => item.kind)).toEqual(["user_message", "assistant_message"]);
    expect([...collapsed.workCountByTurnKey.values()]).toEqual([2]);
  });

  test("Grok-through-Pi keeps every promoted final Markdown block", () => {
    const provider = "pi";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Review", messageId: "user-grok" }, 0),
      timeline(provider, { type: "assistant_message", text: "Checking." }, 1),
      timeline(provider, toolItem({ callId: "grok-tool", status: "completed" }), 2),
      timeline(provider, { type: "reasoning", text: "Verifying" }, 3),
      timeline(provider, { type: "assistant_message", text: "Result A.\n\nResult B." }, 4),
      terminal(provider, { type: "turn_completed" }, 5),
    ]);
    const collapsed = collapseIdle(reduced.tail);

    expect(assistantTexts(collapsed.items)).toEqual(["Result A.", "Result B."]);
    expect([...collapsed.workCountByTurnKey.values()]).toEqual([3]);
  });

  test("Pi keeps a completed answer visible when an autonomous extension settles again", () => {
    const provider = "pi";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Research", messageId: "user-pi" }, 0),
      timeline(provider, { type: "reasoning", text: "Researching" }, 1),
      timeline(provider, toolItem({ callId: "pi-tool", status: "completed" }), 2),
      timeline(
        provider,
        {
          type: "assistant_message",
          text: "The full researched conclusion.",
          messageId: "response-detailed",
        },
        3,
      ),
      terminal(provider, { type: "turn_completed" }, 4),
      timeline(provider, { type: "reasoning", text: "Checking the background fetch" }, 5),
      timeline(
        provider,
        {
          type: "assistant_message",
          text: "The background fetch added nothing new.",
          messageId: "response-background",
        },
        6,
      ),
      terminal(provider, { type: "turn_completed" }, 7),
    ]);
    const collapsed = collapseIdle(reduced.tail);

    expect(assistantTexts(collapsed.items)).toEqual([
      "The full researched conclusion.",
      "The background fetch added nothing new.",
    ]);
    expect(collapsed.workCountByTurnKey.get("response-background")).toBe(3);
  });

  test.each([
    ["failed", terminal("opencode", { type: "turn_failed", error: "provider failed" }, 4)],
    ["canceled", terminal("opencode", { type: "turn_canceled", reason: "interrupted" }, 4)],
  ] as const)("OpenCode %s turns remain losslessly open", (_label, terminalEvent) => {
    const provider = "opencode";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Run", messageId: "user-opencode" }, 0),
      timeline(provider, { type: "reasoning", text: "Working" }, 1),
      timeline(provider, toolItem({ callId: "opencode-tool", status: "failed" }), 2),
      timeline(provider, { type: "assistant_message", text: "Partial result." }, 3),
      terminalEvent,
    ]);
    const collapsed = collapseIdle(reduced.tail);

    expect(collapsed.items).toBe(reduced.tail);
    expect(collapsed.workCountByTurnKey.size).toBe(0);
  });

  test("permission-blocked or disconnected live work never exposes a fold row", () => {
    const provider = "claude";
    const reduced = reduceProviderEvents([
      timeline(provider, { type: "user_message", text: "Deploy", messageId: "user-live" }, 0),
      timeline(provider, { type: "reasoning", text: "Waiting for permission" }, 1),
      timeline(provider, toolItem({ callId: "live-tool", status: "completed" }), 2),
      timeline(provider, { type: "assistant_message", text: "Still active." }, 3),
    ]);
    const projected = collapseCompletedWorkStream({
      tail: reduced.tail,
      head: reduced.head,
      expandedTurnKeys: new Set(),
      isTurnActive: true,
    });

    expect(projected.tail).toBe(reduced.tail);
    expect(projected.head).toBe(reduced.head);
    expect(projected.workCountByTurnKey.size).toBe(0);
    expect(projected.summaryTurnKeyByAssistantId.size).toBe(0);
  });
});
