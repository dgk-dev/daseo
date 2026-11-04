import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import {
  TimelineMessageCollector,
  type TimelineCollectorResult,
  type TimelineCollectorState,
} from "./history-text.js";

/**
 * Reads indexable messages straight from a timeline directory instead of
 * through FileBackedAgentTimelineStore: the store keeps every row it loads in
 * memory for the daemon's lifetime, and a first index build touches every
 * session. Row files are read only from their head unless they are a message
 * row, because tool rows are most of the bytes and none of the text.
 */

const ROW_FILE_PATTERN = /^(\d{16})\.json$/;
const ROW_HEAD_BYTES = 256;
const ITEM_TYPE_PATTERN = /"item"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/;
const READ_CONCURRENCY = 32;

export interface TimelineMessageBatch extends TimelineCollectorResult {
  /** Highest row seq present on disk, read or skipped. */
  maxSeq: number;
}

export function timelineDirectory(timelinesDir: string, agentId: string): string {
  return path.join(timelinesDir, agentId);
}

/** The timeline's cursor epoch, or null when the agent has no timeline. */
export async function readTimelineEpoch(directory: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")) as {
      epoch?: unknown;
    };
    return typeof raw.epoch === "string" && raw.epoch.length > 0 ? raw.epoch : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listRowSeqs(directory: string): Promise<number[]> {
  const names = await fs.readdir(directory);
  const seqs: number[] = [];
  for (const name of names) {
    const match = ROW_FILE_PATTERN.exec(name);
    if (match?.[1]) seqs.push(Number(match[1]));
  }
  return seqs.sort((left, right) => left - right);
}

async function readRowHeadType(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(ROW_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ROW_HEAD_BYTES, 0);
    return ITEM_TYPE_PATTERN.exec(buffer.toString("utf8", 0, bytesRead))?.[1] ?? null;
  } finally {
    await handle.close();
  }
}

type RowRead =
  | { kind: "skip" }
  | { kind: "item"; item: ReturnType<typeof AgentTimelineItemPayloadSchema.parse> };

async function readRow(filePath: string): Promise<RowRead> {
  const headType = await readRowHeadType(filePath);
  // An unrecognized head (a format change) falls through to a full read.
  if (headType !== null && headType !== "user_message" && headType !== "assistant_message") {
    return { kind: "skip" };
  }
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as { item?: unknown };
  const parsed = AgentTimelineItemPayloadSchema.safeParse(raw.item);
  if (!parsed.success) return { kind: "skip" };
  const item = parsed.data;
  if (item.type !== "user_message" && item.type !== "assistant_message") return { kind: "skip" };
  return { kind: "item", item };
}

/** Messages in rows after `afterSeq`. A row removed mid-read is skipped. */
export async function readTimelineMessages(input: {
  directory: string;
  afterSeq: number;
  state: TimelineCollectorState;
}): Promise<TimelineMessageBatch> {
  const seqs = (await listRowSeqs(input.directory)).filter((seq) => seq > input.afterSeq);
  const collector = new TimelineMessageCollector(input.state);
  for (let start = 0; start < seqs.length; start += READ_CONCURRENCY) {
    const batch = seqs.slice(start, start + READ_CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (seq) => {
        try {
          return await readRow(path.join(input.directory, `${String(seq).padStart(16, "0")}.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "skip" } as const;
          throw error;
        }
      }),
    );
    rows.forEach((row, index) => {
      const seq = batch[index];
      if (row.kind === "item" && seq !== undefined) collector.add(seq, row.item);
    });
  }
  return { ...collector.finish(), maxSeq: seqs.at(-1) ?? input.afterSeq };
}
