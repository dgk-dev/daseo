import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            {
              type: "text",
              text: "done",
              textSignature: JSON.stringify({
                v: 1,
                id: "message-final",
                phase: "final_answer",
              }),
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "done",
          messageId: "response-1",
          phase: "final_answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays a Pi steering user message inside the same explicit-phase turn", async () => {
    const signature = (phase: "commentary" | "final_answer") => JSON.stringify({ v: 1, phase });

    await expect(
      collectHistory([
        { role: "user", content: "Start" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Working", textSignature: signature("commentary") }],
        },
        { role: "user", content: "Steer" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done", textSignature: signature("final_answer") }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "user_message", text: "Start" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "Working",
          messageId: "pi-history-assistant-1",
          phase: "commentary",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "user_message", text: "Steer", steering: true },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "Done",
          messageId: "pi-history-assistant-2",
          phase: "final_answer",
        },
      },
    ]);
  });

  test("derives final_answer from a stop reason when no phase signature exists", async () => {
    const events = await collectHistory([
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        responseId: "response-narration",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Checking." },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
      },
      {
        role: "assistant",
        responseId: "response-answer",
        stopReason: "stop",
        content: [{ type: "text", text: "The real answer." }],
      },
      // A queued follow-up (background fetch notification) wakes the model
      // inside the same turn; the earlier answer must still count as one.
      { role: "custom", content: [{ type: "text", text: "Content fetched for 3/3 URLs." }] },
      {
        role: "assistant",
        responseId: "response-followup",
        stopReason: "stop",
        content: [{ type: "text", text: "Nothing else is needed." }],
      },
      // Derived phases must not turn the next prompt into a steer.
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ]);
    const items = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    expect(items.filter((item) => item.type === "assistant_message")).toEqual([
      { type: "assistant_message", text: "Checking.", messageId: "response-narration" },
      {
        type: "assistant_message",
        text: "The real answer.",
        messageId: "response-answer",
        phase: "final_answer",
      },
      { type: "assistant_message", text: "Content fetched for 3/3 URLs.", phase: "commentary" },
      {
        type: "assistant_message",
        text: "Nothing else is needed.",
        messageId: "response-followup",
        phase: "final_answer",
      },
    ]);
    expect(items.findLast((item) => item.type === "user_message")).toEqual({
      type: "user_message",
      text: "next question",
    });
  });

  test("ignores malformed or unknown Pi assistant phase metadata", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [
            { type: "text", text: "malformed", textSignature: "{not-json" },
            {
              type: "text",
              text: "unknown",
              textSignature: JSON.stringify({ phase: "analysis" }),
            },
          ],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "malformed",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "unknown",
          messageId: "pi-history-assistant-1",
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("replays non-notice custom messages as assistant text, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "Extension command output",
          phase: "commentary",
        },
      },
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "first answer",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});
