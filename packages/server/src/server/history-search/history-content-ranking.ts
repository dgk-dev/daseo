import type { AgentSearchSnippet } from "@getpaseo/protocol/messages";
import type { HistoryIndexStore, StoredHistoryMessage } from "./history-index-store.js";

/**
 * Keyword ranking over what was said in each session. Query words are OR'd:
 * a recalled sentence ("the time we rotated the railway keys") rarely appears
 * word for word, so a session scores by how many of the words it contains and
 * how rare they are (BM25, with a message as the unit of term frequency).
 */

export interface ContentMatch {
  agentId: string;
  score: number;
}

export interface ContentRanking {
  matches: ContentMatch[];
  /** Inverse document frequency of each query token, for picking snippets. */
  idfByToken: Map<string, number>;
}

const BM25_K1 = 1.2;
/** Sessions run from one message to thousands; normalize length only gently. */
const BM25_B = 0.5;

export function rankSessionsByContent(input: {
  store: HistoryIndexStore;
  tokens: readonly string[];
  candidateIds: ReadonlySet<string>;
}): ContentRanking {
  const tokens = [...new Set(input.tokens)];
  const sessions = input.store
    .listSessions()
    .filter((session) => session.messageCount > 0 && input.candidateIds.has(session.agentId));
  const idfByToken = new Map<string, number>();
  if (sessions.length === 0 || tokens.length === 0) return { matches: [], idfByToken };

  const lengthByAgent = new Map(sessions.map((session) => [session.agentId, session.messageCount]));
  const averageLength =
    sessions.reduce((total, session) => total + session.messageCount, 0) / sessions.length;
  const scores = new Map<string, number>();
  for (const token of tokens) {
    const counts = input.store.countMatchingMessages(token);
    let documentFrequency = 0;
    for (const agentId of counts.keys()) if (lengthByAgent.has(agentId)) documentFrequency += 1;
    if (documentFrequency === 0) continue;
    const idf = Math.log(
      1 + (sessions.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    idfByToken.set(token, idf);
    for (const [agentId, termFrequency] of counts) {
      const length = lengthByAgent.get(agentId);
      if (length === undefined) continue;
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * length) / averageLength);
      const gain = (idf * termFrequency * (BM25_K1 + 1)) / (termFrequency + norm);
      scores.set(agentId, (scores.get(agentId) ?? 0) + gain);
    }
  }
  const matches = [...scores.entries()]
    .map(([agentId, score]) => ({ agentId, score }))
    .sort((left, right) => right.score - left.score);
  return { matches, idfByToken };
}

const SNIPPET_CHARS = 160;
const SNIPPET_LEAD_CHARS = 40;
const SNAP_CHARS = 12;
const ELLIPSIS = "…";

interface Range {
  start: number;
  length: number;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    found.push(index);
    from = index + needle.length;
  }
  return found;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.start + last.length) {
      last.length = Math.max(last.length, range.start + range.length - last.start);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function snapStart(text: string, start: number): number {
  if (start === 0) return 0;
  const space = text.indexOf(" ", start);
  return space !== -1 && space - start <= SNAP_CHARS ? space + 1 : start;
}

function snapEnd(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const space = text.lastIndexOf(" ", end);
  return space !== -1 && end - space <= SNAP_CHARS ? space : end;
}

function toSnippet(input: {
  message: StoredHistoryMessage;
  text: string;
  start: number;
  end: number;
  ranges: Range[];
}): AgentSearchSnippet {
  const { message, text, start, end } = input;
  const prefix = start > 0 ? ELLIPSIS : "";
  const suffix = end < text.length ? ELLIPSIS : "";
  const shift = prefix.length - start;
  const ranges = mergeRanges(
    input.ranges
      .filter((range) => range.start >= start && range.start + range.length <= end)
      .map((range) => ({ start: range.start + shift, length: range.length })),
  );
  return {
    role: message.role,
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    ranges,
    ...(message.seq !== null ? { seq: message.seq } : {}),
    ...(message.anchorSeq !== null ? { anchorSeq: message.anchorSeq } : {}),
  };
}

/**
 * The message that best explains a content match: the one holding the most
 * (and rarest) query words, the owner's own words on a tie, then the earliest.
 * The window opens a little before the rarest word so it reads in context.
 */
export function buildContentSnippet(input: {
  store: HistoryIndexStore;
  agentId: string;
  tokens: readonly string[];
  idfByToken: ReadonlyMap<string, number>;
}): AgentSearchSnippet | null {
  const tokens = [...new Set(input.tokens)].filter((token) => input.idfByToken.has(token));
  if (tokens.length === 0) return null;
  let best: { message: StoredHistoryMessage; text: string; weight: number; anchor: string } | null =
    null;
  for (const message of input.store.listMatchingMessages(input.agentId, tokens)) {
    const text = collapseWhitespace(message.text);
    const lower = text.toLowerCase();
    let weight = 0;
    let anchor: string | null = null;
    for (const token of tokens) {
      if (!lower.includes(token)) continue;
      const idf = input.idfByToken.get(token) ?? 0;
      weight += idf;
      if (anchor === null || idf > (input.idfByToken.get(anchor) ?? 0)) anchor = token;
    }
    if (anchor === null) continue;
    const better =
      !best ||
      weight > best.weight ||
      (weight === best.weight && message.role === "user" && best.message.role !== "user");
    if (better) best = { message, text, weight, anchor };
  }
  if (!best) return null;

  const lower = best.text.toLowerCase();
  const anchorAt = lower.indexOf(best.anchor);
  const start = snapStart(best.text, Math.max(0, anchorAt - SNIPPET_LEAD_CHARS));
  const end = snapEnd(best.text, Math.min(best.text.length, start + SNIPPET_CHARS));
  const ranges = tokens.flatMap((token) =>
    occurrences(lower, token).map((at) => ({ start: at, length: token.length })),
  );
  return toSnippet({ message: best.message, text: best.text, start, end, ranges });
}

/** The head of a message, unmarked: the session matched by meaning only. */
export function buildMessageSnippet(message: StoredHistoryMessage): AgentSearchSnippet {
  const text = collapseWhitespace(message.text);
  return toSnippet({
    message,
    text,
    start: 0,
    end: snapEnd(text, Math.min(text.length, SNIPPET_CHARS)),
    ranges: [],
  });
}
