import { FileBackedAgentTimelineStore } from "../../agent/file-backed-agent-timeline-store.js";
import type { FixtureSession } from "./history-search-fixture.js";

/** Words that appear only where History search must not look. */
export const TOOL_ONLY_WORD = "toolonlyword";
export const REASONING_ONLY_WORD = "reasoningonlyword";
export const SYSTEM_ONLY_WORD = "systemonlyword";

/**
 * Writes fixture sessions through the real timeline store, so the indexer reads
 * the exact on-disk format the daemon writes. Each turn also carries a tool
 * call, reasoning, and a system-origin prompt, which must never be indexed.
 */
export async function writeFixtureTimelines(input: {
  timelinesDir: string;
  sessions: readonly FixtureSession[];
}): Promise<FileBackedAgentTimelineStore> {
  const store = new FileBackedAgentTimelineStore(input.timelinesDir);
  for (const session of input.sessions) {
    await store.appendCommitted(session.id, {
      type: "user_message",
      text: `<paseo-system>\nA scheduled run woke this agent. ${SYSTEM_ONLY_WORD}\n</paseo-system>`,
      origin: "system",
    });
    for (const message of session.messages) {
      if (message.role === "user") {
        await store.appendCommitted(session.id, { type: "user_message", text: message.text });
        await store.appendCommitted(session.id, {
          type: "reasoning",
          text: `Thinking about it. ${REASONING_ONLY_WORD}`,
        });
        await store.appendCommitted(session.id, {
          type: "tool_call",
          callId: `call-${session.id}-${message.text.length}`,
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: {}, output: `${TOOL_ONLY_WORD} ${"x".repeat(2000)}` },
        });
      } else {
        await store.appendCommitted(session.id, { type: "assistant_message", text: message.text });
      }
    }
  }
  return store;
}
