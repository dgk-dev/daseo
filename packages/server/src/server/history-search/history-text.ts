import { isWaitNotedReply } from "@getpaseo/protocol/wait-noted";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

/**
 * What History search reads from a session: the owner's own messages and the
 * assistant's answers. Tool output is roughly 200x the size of the
 * conversation and mostly noise to a person recalling a session; reasoning is
 * not what anyone remembers having seen; system-origin prompts (wait wakes,
 * schedule fires, notify-on-finish) are Paseo talking, not the owner.
 */
export type HistoryMessageRole = "user" | "assistant";

export interface HistoryMessage {
  role: HistoryMessageRole;
  text: string;
  /** Timeline row of the message; null when read from a provider session file. */
  seq: number | null;
  /** Timeline row of the user prompt that starts the message's turn. */
  anchorSeq: number | null;
}

/** A pasted log can be megabytes; its head is what identifies it. */
export const MAX_INDEXED_MESSAGE_CHARS = 20_000;

/** Joins messages into the text that embedding chunks are cut from. */
export const SESSION_TEXT_SEPARATOR = "\n\n";

export function indexableMessageText(
  item: AgentTimelineItem,
): { role: HistoryMessageRole; text: string } | null {
  if (item.type === "user_message") {
    if (item.origin === "system") return null;
    return clipMessage("user", item.text);
  }
  if (item.type === "assistant_message") {
    return clipMessage("assistant", item.text);
  }
  return null;
}

export function clipMessage(
  role: HistoryMessageRole,
  raw: string,
): { role: HistoryMessageRole; text: string } | null {
  const text = raw.trim();
  if (!text) return null;
  return {
    role,
    text: text.length > MAX_INDEXED_MESSAGE_CHARS ? text.slice(0, MAX_INDEXED_MESSAGE_CHARS) : text,
  };
}

/** Where the last indexed message stands, so the next batch can continue it. */
export interface TimelineCollectorState {
  anchorSeq: number | null;
  /** Last row of a trailing run of assistant rows, or null. */
  tailAssistantSeq: number | null;
}

export interface TimelineCollectorResult {
  /** Text that continues the session's last indexed (assistant) message. */
  continuationText: string | null;
  messages: HistoryMessage[];
  state: TimelineCollectorState;
}

interface AssistantRun {
  firstSeq: number;
  lastSeq: number;
  anchorSeq: number | null;
  text: string;
  continuesIndexed: boolean;
}

/**
 * Turns timeline rows into indexable messages the way the app renders them.
 *
 * - Contiguous assistant rows are one message: some timelines stream an answer
 *   as hundreds of chunk rows, and the app joins them (`lastAssistantRun`).
 *   Rows here are only message rows, so contiguity is consecutive seqs; a tool
 *   call or any other row in between leaves a gap and starts a new message.
 * - A run that is only the wait-noted reply is skipped, as the app hides it.
 * - `anchorSeq` follows every user row, system ones included: the app renders
 *   a system prompt as a boundary row with its own timeline position, so it is
 *   a valid place to open a turn at.
 */
export class TimelineMessageCollector {
  private anchorSeq: number | null;
  private run: AssistantRun | null = null;
  private continuationText: string | null = null;
  /** Last row of the trailing assistant run that is indexed, or null. */
  private tailAssistantSeq: number | null;
  private readonly messages: HistoryMessage[] = [];

  constructor(initial: TimelineCollectorState) {
    this.anchorSeq = initial.anchorSeq;
    this.tailAssistantSeq = initial.tailAssistantSeq;
  }

  add(seq: number, item: AgentTimelineItem): void {
    if (item.type === "assistant_message") {
      if (this.run && seq === this.run.lastSeq + 1) {
        this.run.text += item.text;
        this.run.lastSeq = seq;
        return;
      }
      this.finishRun();
      const continuesIndexed = this.tailAssistantSeq !== null && seq === this.tailAssistantSeq + 1;
      this.run = {
        firstSeq: seq,
        lastSeq: seq,
        anchorSeq: this.anchorSeq,
        text: item.text,
        continuesIndexed,
      };
      return;
    }
    this.finishRun();
    this.tailAssistantSeq = null;
    if (item.type !== "user_message") return;
    this.anchorSeq = seq;
    const indexable = indexableMessageText(item);
    if (indexable) this.messages.push({ ...indexable, seq, anchorSeq: seq });
  }

  finish(): TimelineCollectorResult {
    this.finishRun();
    return {
      continuationText: this.continuationText,
      messages: this.messages,
      state: { anchorSeq: this.anchorSeq, tailAssistantSeq: this.tailAssistantSeq },
    };
  }

  private finishRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.continuesIndexed) {
      // Only the session's last indexed message can be continued, so this is
      // the first message of the batch.
      this.continuationText = run.text;
      this.tailAssistantSeq = run.lastSeq;
      return;
    }
    const indexable = isWaitNotedReply(run.text) ? null : clipMessage("assistant", run.text);
    if (!indexable) {
      this.tailAssistantSeq = null;
      return;
    }
    this.messages.push({
      ...indexable,
      seq: run.firstSeq,
      anchorSeq: run.anchorSeq ?? run.firstSeq,
    });
    this.tailAssistantSeq = run.lastSeq;
  }
}

export interface EmbeddingChunk {
  /** Index of the fixed 1,000-character window inside the session text. */
  window: number;
  text: string;
  /** Ordinal of the message the window starts in. */
  messageOrdinal: number;
}

export const EMBEDDING_CHUNK_CHARS = 1_000;
export const MAX_EMBEDDING_CHUNKS_PER_SESSION = 12;

/**
 * Fixed windows sampled evenly across the session. Windows sit at fixed
 * offsets so that a growing session keeps most window contents identical and
 * their vectors can be reused instead of re-embedded.
 */
export function selectEmbeddingChunks(
  messages: readonly { text: string }[],
  options: { chunkChars?: number; maxChunks?: number } = {},
): EmbeddingChunk[] {
  const chunkChars = options.chunkChars ?? EMBEDDING_CHUNK_CHARS;
  const maxChunks = options.maxChunks ?? MAX_EMBEDDING_CHUNKS_PER_SESSION;
  const starts: number[] = [];
  let text = "";
  for (const message of messages) {
    if (text.length > 0) text += SESSION_TEXT_SEPARATOR;
    starts.push(text.length);
    text += message.text;
  }
  if (!text) return [];

  const windowCount = Math.ceil(text.length / chunkChars);
  const windows: number[] = [];
  if (windowCount <= maxChunks) {
    for (let window = 0; window < windowCount; window += 1) windows.push(window);
  } else {
    for (let k = 0; k < maxChunks; k += 1) {
      windows.push(Math.floor((k * windowCount) / maxChunks));
    }
  }

  return windows.map((window) => {
    const start = window * chunkChars;
    return {
      window,
      text: text.slice(start, start + chunkChars),
      messageOrdinal: messageOrdinalAt(starts, start),
    };
  });
}

function messageOrdinalAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}
