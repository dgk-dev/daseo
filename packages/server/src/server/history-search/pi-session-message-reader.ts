import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { withSystemPromptOrigin } from "../agent/agent-prompt.js";
import { PiHistoryMapper } from "../agent/providers/pi/history-mapper.js";
import type { PiAgentMessage } from "../agent/providers/pi/rpc-types.js";
import { indexableMessageText, type HistoryMessage } from "./history-text.js";

/**
 * Sessions from before Paseo kept its own timelines (August 2026 on this Mac)
 * exist only as the Pi session file named by `persistence.nativeHandle`. They
 * are read through the same mapper Pi resume uses, so what is indexed is what
 * the app would show. Messages have no timeline row, so they carry no seq.
 */

/** `<mtimeMs>:<size>`, or null when the file is gone. */
export async function readPiSessionFileMark(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? `${Math.trunc(stat.mtimeMs)}:${stat.size}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isPiMessageEntry(value: unknown): value is { type: "message"; message: PiAgentMessage } {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { type?: unknown; message?: unknown };
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    typeof (entry.message as { role?: unknown }).role === "string"
  );
}

export async function readPiSessionMessages(filePath: string): Promise<HistoryMessage[]> {
  const messages: PiAgentMessage[] = [];
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line.startsWith('{"type":"message"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPiMessageEntry(entry)) messages.push(entry.message);
  }

  const indexed: HistoryMessage[] = [];
  for (const event of new PiHistoryMapper("pi").mapMessages(messages)) {
    if (event.type !== "timeline") continue;
    const indexable = indexableMessageText(withSystemPromptOrigin(event.item));
    if (indexable) indexed.push({ ...indexable, seq: null, anchorSeq: null });
  }
  return indexed;
}
