import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  escapeMarkdownImageSource,
  isMaterializedProviderImagePath,
} from "../agent/providers/provider-image-output.js";
import { resolveReadableImageFileSync } from "../file-explorer/service.js";
import { expandUserPath } from "../path-utils.js";
import type {
  AssistantImageSnapshotEntry,
  AssistantImageSnapshotStore,
} from "./assistant-image-snapshot-store.js";
import {
  createMarkdownImageScanState,
  rewriteMarkdownImageSources,
  type MarkdownImageScanState,
} from "./markdown-image-sources.js";

/**
 * `live`: the item was just emitted, so the file on disk holds the bytes the message means;
 * snapshot it. `history`: the item was rebuilt from provider history, so the file may have
 * changed since; only resolve to a snapshot taken when the item was first emitted.
 */
export type AssistantImageRewriteMode = "live" | "history";

interface AgentRewriteState {
  scan: MarkdownImageScanState;
  /** Per source path: how many history items in the current replay pass already used it. */
  replayCursor: Map<string, number>;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The local file path a Markdown image source names, or null for a remote or inline source. */
function localPathForSource(source: string, cwd: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (/^file:/i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (URL_SCHEME.test(trimmed)) {
    return null;
  }
  if (trimmed === "~" || trimmed.startsWith("~/") || path.isAbsolute(trimmed)) {
    return expandUserPath(trimmed);
  }
  return path.resolve(cwd, trimmed);
}

function pickHistoryEntry(input: {
  entries: AssistantImageSnapshotEntry[];
  timestamp?: string;
  ordinal: number;
}): AssistantImageSnapshotEntry {
  const { entries } = input;
  if (entries.length === 1) {
    return entries[0];
  }
  const target = input.timestamp ? Date.parse(input.timestamp) : Number.NaN;
  if (!Number.isNaN(target)) {
    let best = entries[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      const distance = Math.abs(Date.parse(entry.emittedAt) - target);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best;
  }
  return entries[Math.min(input.ordinal, entries.length - 1)];
}

/**
 * Daseo: rewrites the image sources of assistant messages to durable snapshots, so a past
 * message keeps the picture it showed when the agent wrote it after the file is overwritten
 * or deleted, after restarts, and after history is rebuilt from the provider.
 */
export class AssistantImageSnapshotter {
  private readonly states = new Map<string, AgentRewriteState>();

  constructor(private readonly store: AssistantImageSnapshotStore) {}

  rewriteItem(input: {
    agentId: string;
    cwd: string;
    item: AgentTimelineItem;
    mode: AssistantImageRewriteMode;
    timestamp?: string;
  }): AgentTimelineItem {
    const { item } = input;
    const state = this.stateFor(input.agentId);
    if (item.type !== "assistant_message") {
      // A reply ends at any other item; its fences and code spans do not carry over.
      state.scan = createMarkdownImageScanState();
      return item;
    }
    if (!item.text.includes("![") && state.scan.fence === null) {
      return item;
    }
    const emittedAt = input.timestamp ?? new Date().toISOString();
    const text = rewriteMarkdownImageSources({
      text: item.text,
      state: state.scan,
      rewrite: (source) => {
        const snapshotPath =
          input.mode === "live"
            ? this.snapshotLive({ agentId: input.agentId, cwd: input.cwd, source, emittedAt })
            : this.resolveHistory({
                agentId: input.agentId,
                cwd: input.cwd,
                source,
                emittedAt,
                ...(input.timestamp ? { timestamp: input.timestamp } : {}),
                state,
              });
        return snapshotPath ? escapeMarkdownImageSource(snapshotPath) : null;
      },
    });
    return text === item.text ? item : { ...item, text };
  }

  /** Starts a history replay pass: earlier replays no longer count toward entry order. */
  beginReplay(agentId: string): void {
    const state = this.stateFor(agentId);
    state.replayCursor.clear();
    state.scan = createMarkdownImageScanState();
  }

  deleteAgent(agentId: string): void {
    this.states.delete(agentId);
    this.store.deleteAgent(agentId);
  }

  private stateFor(agentId: string): AgentRewriteState {
    let state = this.states.get(agentId);
    if (!state) {
      state = { scan: createMarkdownImageScanState(), replayCursor: new Map() };
      this.states.set(agentId, state);
    }
    return state;
  }

  private snapshotLive(input: {
    agentId: string;
    cwd: string;
    source: string;
    emittedAt: string;
  }): string | null {
    const filePath = localPathForSource(input.source, input.cwd);
    if (!filePath) {
      return null;
    }
    const existing = this.store.parseSnapshotPath(filePath);
    if (existing) {
      // Already a snapshot (an agent quoting an earlier message): keep the source, count the
      // reference so deleting the first agent keeps the blob.
      this.store.reference({ agentId: input.agentId, ...existing, emittedAt: input.emittedAt });
      return null;
    }
    const readable = resolveReadableImageFileSync({ root: input.cwd, filePath });
    if (!readable) {
      return null;
    }
    const entry = this.store.snapshot({
      agentId: input.agentId,
      source: readable.requestedPath,
      resolvedPath: readable.resolvedPath,
      emittedAt: input.emittedAt,
    });
    return entry ? this.store.blobPath(entry) : null;
  }

  private resolveHistory(input: {
    agentId: string;
    cwd: string;
    source: string;
    emittedAt: string;
    timestamp?: string;
    state: AgentRewriteState;
  }): string | null {
    const filePath = localPathForSource(input.source, input.cwd);
    if (!filePath) {
      return null;
    }
    if (this.store.parseSnapshotPath(filePath)) {
      return null;
    }
    const entries = this.store.entriesFor(input.agentId, filePath);
    if (entries.length > 0) {
      const ordinal = input.state.replayCursor.get(filePath) ?? 0;
      input.state.replayCursor.set(filePath, ordinal + 1);
      return this.store.blobPath(
        pickHistoryEntry({
          entries,
          ordinal,
          ...(input.timestamp ? { timestamp: input.timestamp } : {}),
        }),
      );
    }
    // A provider byte image is named by its content hash, so its file still holds the bytes
    // the message showed and can be snapshotted now.
    if (isMaterializedProviderImagePath(filePath)) {
      return this.snapshotLive({
        agentId: input.agentId,
        cwd: input.cwd,
        source: input.source,
        emittedAt: input.emittedAt,
      });
    }
    return null;
  }
}
