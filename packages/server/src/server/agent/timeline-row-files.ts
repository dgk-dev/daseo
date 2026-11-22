import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * On-disk layout of one agent's committed timeline (Daseo delta 146).
 *
 * `<agent>/<16-digit seq>.json` is one row per file ("loose" rows). Archived
 * agents can be compacted into `<agent>/rows.jsonl`, one compact row per line in
 * ascending seq. Both forms may exist at once: loose files are an overlay, so a
 * loose file wins over the bundle line with the same seq. Every reader of a
 * timeline directory goes through this module so the merge rule lives once.
 */

export const TIMELINE_BUNDLE_FILE = "rows.jsonl";
/** Written by compaction, renamed over the bundle; loaders never read it. */
export const TIMELINE_BUNDLE_TEMP_FILE = "rows.jsonl.tmp";
const LOOSE_ROW_FILE_PATTERN = /^(\d{16})\.json$/;
const BUNDLE_LINE_SEQ_PATTERN = /^\{"seq":(\d+),/;
/** Files stat-ed concurrently when measuring disk use. */
const STAT_BATCH = 32;
/** A listing whose files vanish mid-read is taken again this many times in total. */
const MAX_READ_ATTEMPTS = 3;

export function looseRowFileName(seq: number): string {
  return `${String(seq).padStart(16, "0")}.json`;
}

export interface TimelineDirectoryListing {
  /** Loose row seqs, ascending. */
  looseSeqs: number[];
  hasBundle: boolean;
}

/** Throws ENOENT when the directory does not exist. */
export async function listTimelineDirectory(directory: string): Promise<TimelineDirectoryListing> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const looseSeqs: number[] = [];
  let hasBundle = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === TIMELINE_BUNDLE_FILE) {
      hasBundle = true;
      continue;
    }
    const match = LOOSE_ROW_FILE_PATTERN.exec(entry.name);
    if (match?.[1]) looseSeqs.push(Number(match[1]));
  }
  looseSeqs.sort((left, right) => left - right);
  return { looseSeqs, hasBundle };
}

export class TimelineFormatError extends Error {
  constructor(
    message: string,
    public readonly directory: string,
  ) {
    super(message);
    this.name = "TimelineFormatError";
  }
}

/**
 * A file the listing named was gone when it was read: a compaction moved it into
 * the bundle, or the timeline was deleted. The caller lists again.
 */
export class TimelineListingChangedError extends Error {
  constructor(public readonly filePath: string) {
    super(`Timeline file vanished while reading: ${filePath}`);
    this.name = "TimelineListingChangedError";
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export interface BundleLine {
  seq: number;
  /** 1-based, for error messages. */
  lineNumber: number;
  text: string;
}

/** The seq of one bundle line, read from its prefix without parsing the row when possible. */
export function bundleLineSeq(text: string): number | null {
  const fast = BUNDLE_LINE_SEQ_PATTERN.exec(text)?.[1];
  if (fast) return Number(fast);
  const parsed = JSON.parse(text) as { seq?: unknown };
  return typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0
    ? parsed.seq
    : null;
}

/**
 * Streams the bundle's lines in file order, one line in memory at a time
 * (`fileName` lets compaction verify its temporary file the same way).
 * Throws TimelineListingChangedError when the bundle is gone, and
 * TimelineFormatError for a line without a valid seq or a seq out of order.
 */
export async function* readBundleLines(
  directory: string,
  fileName: string = TIMELINE_BUNDLE_FILE,
): AsyncGenerator<BundleLine> {
  const bundlePath = path.join(directory, fileName);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(bundlePath, "r");
  } catch (error) {
    if (isMissingFile(error)) throw new TimelineListingChangedError(bundlePath);
    throw error;
  }
  try {
    let lineNumber = 0;
    let previousSeq = 0;
    for await (const text of splitLines(handle)) {
      lineNumber += 1;
      if (text.length === 0) continue;
      let seq: number | null;
      try {
        seq = bundleLineSeq(text);
      } catch {
        seq = null;
      }
      if (seq === null) {
        throw new TimelineFormatError(
          `Malformed timeline bundle line ${lineNumber} in ${bundlePath}`,
          directory,
        );
      }
      if (seq <= previousSeq) {
        throw new TimelineFormatError(
          `Timeline bundle seq ${seq} out of order at line ${lineNumber} in ${bundlePath}`,
          directory,
        );
      }
      previousSeq = seq;
      yield { seq, lineNumber, text };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Splits on "\n" bytes only. node:readline also ends a line at U+2028 and
 * U+2029, which JSON.stringify leaves unescaped inside strings, so it would cut
 * a row in two. A line is decoded only once whole, so no UTF-8 sequence splits.
 */
async function* splitLines(handle: fs.FileHandle): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    const buffer = chunk as Buffer;
    let start = 0;
    for (let end = buffer.indexOf(0x0a, start); end !== -1; end = buffer.indexOf(0x0a, start)) {
      const piece = buffer.subarray(start, end);
      yield (pending.length > 0 ? Buffer.concat([...pending, piece]) : piece).toString("utf8");
      pending = [];
      start = end + 1;
    }
    if (start < buffer.length) pending.push(buffer.subarray(start));
  }
  if (pending.length > 0) yield Buffer.concat(pending).toString("utf8");
}

/** Reads a loose row file's text; a vanished file means the listing changed. */
export async function readLooseRowText(directory: string, seq: number): Promise<string> {
  const filePath = path.join(directory, looseRowFileName(seq));
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) throw new TimelineListingChangedError(filePath);
    throw error;
  }
}

/**
 * Runs a whole-directory read, listing again when a listed file vanished. After
 * the last attempt the vanished-file error propagates; a reader that tolerates a
 * timeline deleted mid-read checks `isFinalReadAttempt` and skips instead.
 */
export async function withListingRetry<T>(read: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read(attempt);
    } catch (error) {
      if (!(error instanceof TimelineListingChangedError) || attempt >= MAX_READ_ATTEMPTS) {
        throw error;
      }
    }
  }
}

export function isFinalReadAttempt(attempt: number): boolean {
  return attempt >= MAX_READ_ATTEMPTS;
}

export interface RawTimelineRow {
  seq: number;
  /** The row exactly as JSON.parse returned it, unvalidated. */
  raw: unknown;
  source: "bundle" | "loose";
}

export interface RawTimelineRead {
  /** Bundle rows overlaid by loose rows, ascending seq. */
  rows: RawTimelineRow[];
  /** Loose row file names this read consumed (the only files compaction may unlink). */
  looseFileNames: string[];
  hadBundle: boolean;
}

/**
 * Reads every committed row of one timeline directory: bundle first, then loose
 * files, a loose file replacing the bundle line with the same seq. Any malformed
 * JSON throws, as a malformed row file always has. Throws ENOENT when the
 * directory does not exist.
 */
export async function readRawTimelineRows(directory: string): Promise<RawTimelineRead> {
  return withListingRetry(async () => {
    const listing = await listTimelineDirectory(directory);
    const looseSet = new Set(listing.looseSeqs);
    const rows: RawTimelineRow[] = [];
    if (listing.hasBundle) {
      for await (const line of readBundleLines(directory)) {
        if (looseSet.has(line.seq)) continue;
        rows.push({
          seq: line.seq,
          raw: parseJson(line.text, directory, line.lineNumber),
          source: "bundle",
        });
      }
    }
    for (const seq of listing.looseSeqs) {
      rows.push({ seq, raw: JSON.parse(await readLooseRowText(directory, seq)), source: "loose" });
    }
    rows.sort((left, right) => left.seq - right.seq);
    return {
      rows,
      looseFileNames: listing.looseSeqs.map(looseRowFileName),
      hadBundle: listing.hasBundle,
    };
  });
}

function parseJson(text: string, directory: string, lineNumber: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TimelineFormatError(
      `Malformed timeline bundle line ${lineNumber} in ${path.join(directory, TIMELINE_BUNDLE_FILE)}`,
      directory,
    );
  }
}

/** Disk blocks a file holds (4 KB minimum per file on APFS), not its logical size. */
export function allocatedBytes(stats: { blocks: number; size: number }): number {
  // Windows reports no blocks; the logical size is the closest figure there.
  return Number.isFinite(stats.blocks) && stats.blocks > 0 ? stats.blocks * 512 : stats.size;
}

export async function sumAllocatedBytes(filePaths: readonly string[]): Promise<number> {
  let total = 0;
  for (let start = 0; start < filePaths.length; start += STAT_BATCH) {
    const batch = filePaths.slice(start, start + STAT_BATCH);
    const sizes = await Promise.all(
      batch.map(async (filePath) => {
        try {
          return allocatedBytes(await fs.stat(filePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      }),
    );
    for (const size of sizes) total += size;
  }
  return total;
}
