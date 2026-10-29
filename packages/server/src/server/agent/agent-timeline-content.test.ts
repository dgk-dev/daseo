import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("bounds generic tool payloads without changing the provider history", () => {
    const output = { content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] };
    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "mcp-1",
      name: "mcpScript",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: { code: "read()" }, output },
    });
    expect(JSON.stringify(item).length).toBeLessThan(66 * 1024);
    expect(output.content[0].text.length).toBe(2 * 1024 * 1024);
    expect(item).toMatchObject({ detail: { input: { code: "read()" } } });
    expect(JSON.stringify(item)).toContain("truncated");
  });

  test("limits terminal input to the tool-call content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024),
        icon: "square_terminal",
      },
    });
  });
});
