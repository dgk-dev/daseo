import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import {
  isFinalReadAttempt,
  listTimelineDirectory,
  looseRowFileName,
  readBundleLines,
  TimelineListingChangedError,
  withListingRetry,
} from "../agent/timeline-row-files.js";
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
 * row, because tool rows are most of the bytes and none of the text. A
 * compacted timeline (`rows.jsonl`, Daseo delta 146) is streamed line by line
 * with the same head test, and loose files overlay it as they do in the store.
 */

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

type MessageItem = ReturnType<typeof AgentTimelineItemPayloadSchema.parse>;
type RowRead = { kind: "skip" } | { kind: "item"; item: MessageItem };

interface SeqMessage {
  seq: number;
  item: MessageItem;
}

function isSkippedHeadType(headType: string | null): boolean {
  // An unrecognized head (a format change) falls through to a full read.
  return headType !== null && headType !== "user_message" && headType !== "assistant_message";
}

function messageFromRowText(text: string): RowRead {
  const raw = JSON.parse(text) as { item?: unknown };
  const parsed = AgentTimelineItemPayloadSchema.safeParse(raw.item);
  if (!parsed.success) return { kind: "skip" };
  const item = parsed.data;
  if (item.type !== "user_message" && item.type !== "assistant_message") return { kind: "skip" };
  return { kind: "item", item };
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

async function readLooseRow(filePath: string): Promise<RowRead> {
  if (isSkippedHeadType(await readRowHeadType(filePath))) return { kind: "skip" };
  return messageFromRowText(await fs.readFile(filePath, "utf8"));
}

function readBundleRow(text: string): RowRead {
  if (isSkippedHeadType(ITEM_TYPE_PATTERN.exec(text.slice(0, ROW_HEAD_BYTES))?.[1] ?? null)) {
    return { kind: "skip" };
  }
  return messageFromRowText(text);
}

/**
 * Messages in rows after `afterSeq`. A file that vanishes mid-read (a compaction
 * moved it into the bundle) makes the whole read start again from a new
 * listing; a row still missing on the last attempt was deleted and is skipped.
 */
export async function readTimelineMessages(input: {
  directory: string;
  afterSeq: number;
  state: TimelineCollectorState;
}): Promise<TimelineMessageBatch> {
  return withListingRetry(async (attempt) => {
    const tolerateMissing = isFinalReadAttempt(attempt);
    const listing = await listTimelineDirectory(input.directory);
    const looseSet = new Set(listing.looseSeqs);
    let maxSeq = input.afterSeq;

    const bundleMessages: SeqMessage[] = [];
    if (listing.hasBundle) {
      try {
        for await (const line of readBundleLines(input.directory)) {
          if (line.seq <= input.afterSeq || looseSet.has(line.seq)) continue;
          maxSeq = Math.max(maxSeq, line.seq);
          const row = readBundleRow(line.text);
          if (row.kind === "item") bundleMessages.push({ seq: line.seq, item: row.item });
        }
      } catch (error) {
        if (!(error instanceof TimelineListingChangedError && tolerateMissing)) throw error;
      }
    }

    const seqs = listing.looseSeqs.filter((seq) => seq > input.afterSeq);
    maxSeq = Math.max(maxSeq, seqs.at(-1) ?? input.afterSeq);
    const looseMessages: SeqMessage[] = [];
    for (let start = 0; start < seqs.length; start += READ_CONCURRENCY) {
      const batch = seqs.slice(start, start + READ_CONCURRENCY);
      const rows = await Promise.all(
        batch.map(async (seq) => {
          const filePath = path.join(input.directory, looseRowFileName(seq));
          try {
            return await readLooseRow(filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (tolerateMissing) return { kind: "skip" } as const;
            throw new TimelineListingChangedError(filePath);
          }
        }),
      );
      rows.forEach((row, index) => {
        const seq = batch[index];
        if (row.kind === "item" && seq !== undefined) looseMessages.push({ seq, item: row.item });
      });
    }

    const collector = new TimelineMessageCollector(input.state);
    let bundleIndex = 0;
    let looseIndex = 0;
    while (bundleIndex < bundleMessages.length || looseIndex < looseMessages.length) {
      const fromBundle = bundleMessages[bundleIndex];
      const fromLoose = looseMessages[looseIndex];
      if (fromBundle && (!fromLoose || fromBundle.seq < fromLoose.seq)) {
        collector.add(fromBundle.seq, fromBundle.item);
        bundleIndex += 1;
      } else if (fromLoose) {
        collector.add(fromLoose.seq, fromLoose.item);
        looseIndex += 1;
      }
    }
    return { ...collector.finish(), maxSeq };
  });
}
