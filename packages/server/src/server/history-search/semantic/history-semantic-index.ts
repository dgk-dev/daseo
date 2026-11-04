import { createHash } from "node:crypto";
import type pino from "pino";
import type { HistoryChunkInput, HistoryIndexStore } from "../history-index-store.js";
import { selectEmbeddingChunks } from "../history-text.js";
import {
  ensureEmbeddingModel,
  embeddingModelTotalBytes,
  type EmbeddingModelSpec,
} from "./embedding-model.js";

/**
 * Semantic ranking for History search: each session is a handful of
 * 1,000-character windows embedded with the local e5 model, and a session
 * scores as its best window (max-sim). Brute-force cosine over every window is
 * a few milliseconds at this size, so there is no vector index.
 *
 * Until the model is on disk and a session has vectors, that session simply
 * has no semantic score; keyword search keeps working.
 */

export interface HistoryEmbedder {
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  shutdown(): void;
}

export type HistorySemanticStatus =
  | { state: "disabled"; embeddedSessions: number; totalSessions: number }
  | {
      state: "downloading";
      embeddedSessions: number;
      totalSessions: number;
      downloadedBytes: number;
      totalBytes: number;
    }
  | { state: "failed"; embeddedSessions: number; totalSessions: number; error: string }
  | { state: "indexing" | "ready"; embeddedSessions: number; totalSessions: number };

export interface SemanticMatch {
  agentId: string;
  similarity: number;
  /** Message the best window starts in. */
  messageId: number;
}

export interface HistorySemanticIndexOptions {
  store: HistoryIndexStore;
  spec: EmbeddingModelSpec;
  modelsDir: string;
  logger: pino.Logger;
  /** Built once the model files are on disk. */
  createEmbedder: (modelDir: string) => HistoryEmbedder;
  ensureModel?: typeof ensureEmbeddingModel;
  /** A live session is re-embedded at most this often. */
  reembedIntervalMs?: number;
  batchSize?: number;
  now?: () => number;
}

const DEFAULT_REEMBED_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 8;
/** Sessions whose best window is this far down are not semantic matches. */
export const SEMANTIC_RESULT_LIMIT = 30;

interface SessionVectors {
  vectors: Float32Array[];
  messageIds: number[];
}

function chunkHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return sum;
}

type ModelState =
  | { state: "idle" }
  | { state: "downloading"; downloadedBytes: number; totalBytes: number }
  | { state: "failed"; error: string }
  | { state: "ready"; embedder: HistoryEmbedder };

export class HistorySemanticIndex {
  private readonly store: HistoryIndexStore;
  private readonly spec: EmbeddingModelSpec;
  private readonly modelsDir: string;
  private readonly logger: pino.Logger;
  private readonly createEmbedder: (modelDir: string) => HistoryEmbedder;
  private readonly ensureModel: typeof ensureEmbeddingModel;
  private readonly reembedIntervalMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly vectorsByAgent = new Map<string, SessionVectors>();
  private readonly lastEmbeddedAt = new Map<string, number>();
  private model: ModelState = { state: "idle" };
  private pass: Promise<void> | null = null;
  private rerunRequested = false;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadAbort: AbortController | null = null;
  private stopped = false;

  constructor(options: HistorySemanticIndexOptions) {
    this.store = options.store;
    this.spec = options.spec;
    this.modelsDir = options.modelsDir;
    this.logger = options.logger.child({ component: "history-semantic-index" });
    this.createEmbedder = options.createEmbedder;
    this.ensureModel = options.ensureModel ?? ensureEmbeddingModel;
    this.reembedIntervalMs = options.reembedIntervalMs ?? DEFAULT_REEMBED_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = options.now ?? Date.now;
    this.loadVectors();
  }

  /** Downloads the model if needed, then embeds whatever is missing. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.model.state !== "idle" && this.model.state !== "failed") return;
    const totalBytes = embeddingModelTotalBytes(this.spec);
    this.model = { state: "downloading", downloadedBytes: 0, totalBytes };
    this.downloadAbort = new AbortController();
    try {
      const modelDir = await this.ensureModel({
        modelsDir: this.modelsDir,
        spec: this.spec,
        signal: this.downloadAbort.signal,
        onProgress: (downloadedBytes) => {
          if (this.model.state === "downloading") {
            this.model = { state: "downloading", downloadedBytes, totalBytes };
          }
        },
      });
      if (this.stopped) return;
      this.model = { state: "ready", embedder: this.createEmbedder(modelDir) };
      this.logger.info({ model: this.spec.id }, "History search embedding model ready");
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      this.model = { state: "failed", error: message };
      this.logger.warn({ err: error, model: this.spec.id }, "History search model unavailable");
      return;
    } finally {
      this.downloadAbort = null;
    }
    await this.runPass();
  }

  /** The session's indexed text changed or it left the index. */
  notifySessionChanged(agentId: string): void {
    if (!this.store.getSession(agentId)) {
      this.vectorsByAgent.delete(agentId);
      this.lastEmbeddedAt.delete(agentId);
      return;
    }
    if (this.model.state === "ready") void this.runPass();
  }

  status(): HistorySemanticStatus {
    const sessions = this.store.listSessions().filter((session) => session.textChars > 0);
    const totalSessions = sessions.length;
    const embeddedSessions = sessions.filter(
      (session) => session.embeddedModel === this.spec.id && session.embeddedChars !== null,
    ).length;
    switch (this.model.state) {
      case "idle":
        return { state: "disabled", embeddedSessions, totalSessions };
      case "downloading":
        return {
          state: "downloading",
          embeddedSessions,
          totalSessions,
          downloadedBytes: this.model.downloadedBytes,
          totalBytes: this.model.totalBytes,
        };
      case "failed":
        return { state: "failed", embeddedSessions, totalSessions, error: this.model.error };
      case "ready":
        return {
          state: embeddedSessions < totalSessions ? "indexing" : "ready",
          embeddedSessions,
          totalSessions,
        };
    }
  }

  /**
   * The sessions most similar to the query, best first, or null when semantic
   * search is not available yet. Only sessions in `candidateIds` are ranked.
   */
  async rank(input: {
    query: string;
    candidateIds: ReadonlySet<string>;
    limit?: number;
  }): Promise<SemanticMatch[] | null> {
    if (this.model.state !== "ready" || this.vectorsByAgent.size === 0) return null;
    let queryVector: Float32Array;
    try {
      queryVector = await this.model.embedder.embedQuery(input.query);
    } catch (error) {
      this.logger.warn({ err: error }, "History search query embedding failed");
      return null;
    }
    const matches: SemanticMatch[] = [];
    for (const [agentId, session] of this.vectorsByAgent) {
      if (!input.candidateIds.has(agentId)) continue;
      let best = Number.NEGATIVE_INFINITY;
      let bestIndex = 0;
      session.vectors.forEach((vector, index) => {
        const similarity = dot(queryVector, vector);
        if (similarity > best) {
          best = similarity;
          bestIndex = index;
        }
      });
      const messageId = session.messageIds[bestIndex];
      if (messageId !== undefined) matches.push({ agentId, similarity: best, messageId });
    }
    matches.sort((left, right) => right.similarity - left.similarity);
    return matches.slice(0, input.limit ?? SEMANTIC_RESULT_LIMIT);
  }

  /** Resolves when no embedding pass is running; used by tests. */
  async idle(): Promise<void> {
    while (this.pass) await this.pass;
  }

  stop(): void {
    this.stopped = true;
    this.downloadAbort?.abort();
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    if (this.model.state === "ready") this.model.embedder.shutdown();
  }

  private loadVectors(): void {
    const sessions = new Map(
      this.store.listSessions().map((session) => [session.agentId, session]),
    );
    for (const chunk of this.store.listAllChunks()) {
      if (sessions.get(chunk.agentId)?.embeddedModel !== this.spec.id) continue;
      const entry = this.vectorsByAgent.get(chunk.agentId) ?? { vectors: [], messageIds: [] };
      entry.vectors.push(chunk.vector);
      entry.messageIds.push(chunk.messageId);
      this.vectorsByAgent.set(chunk.agentId, entry);
    }
  }

  private runPass(): Promise<void> {
    if (this.pass) {
      this.rerunRequested = true;
      return this.pass;
    }
    this.pass = (async () => {
      do {
        this.rerunRequested = false;
        await this.embedOutstanding();
      } while (this.rerunRequested && !this.stopped);
    })().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async embedOutstanding(): Promise<void> {
    let deferredUntil: number | null = null;
    // Never-embedded sessions first: they are what the progress count waits on.
    const outstanding = this.store
      .listSessions()
      .filter(
        (session) =>
          session.textChars > 0 &&
          (session.embeddedModel !== this.spec.id || session.embeddedChars !== session.textChars),
      )
      .sort(
        (left, right) => Number(left.embeddedChars !== null) - Number(right.embeddedChars !== null),
      );
    for (const session of outstanding) {
      if (this.stopped || this.model.state !== "ready") return;
      const last = this.lastEmbeddedAt.get(session.agentId);
      if (session.embeddedChars !== null && last !== undefined) {
        const due = last + this.reembedIntervalMs;
        if (due > this.now()) {
          deferredUntil = deferredUntil === null ? due : Math.min(deferredUntil, due);
          continue;
        }
      }
      try {
        await this.embedSession(session.agentId, this.model.embedder);
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: session.agentId },
          "History session embedding failed",
        );
        return;
      }
    }
    if (deferredUntil !== null) this.scheduleDeferredPass(deferredUntil);
  }

  private scheduleDeferredPass(at: number): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = setTimeout(
      () => {
        this.deferredTimer = null;
        void this.runPass();
      },
      Math.max(0, at - this.now()),
    );
    this.deferredTimer.unref?.();
  }

  private async embedSession(agentId: string, embedder: HistoryEmbedder): Promise<void> {
    const session = this.store.getSession(agentId);
    if (!session) return;
    const messages = this.store.listMessages(agentId);
    const chunks = selectEmbeddingChunks(messages);
    const reusable =
      session.embeddedModel === this.spec.id
        ? new Map(this.store.listChunks(agentId).map((chunk) => [chunk.window, chunk]))
        : new Map();
    const inputs: HistoryChunkInput[] = [];
    const toEmbed: { index: number; text: string }[] = [];
    chunks.forEach((chunk, index) => {
      const textHash = chunkHash(chunk.text);
      const messageId = messages[chunk.messageOrdinal]?.id ?? messages[0]?.id ?? 0;
      const previous = reusable.get(chunk.window);
      inputs.push({
        window: chunk.window,
        messageId,
        textHash,
        vector: previous?.textHash === textHash ? previous.vector : new Float32Array(0),
      });
      if (previous?.textHash !== textHash) toEmbed.push({ index, text: chunk.text });
    });
    for (let start = 0; start < toEmbed.length; start += this.batchSize) {
      const batch = toEmbed.slice(start, start + this.batchSize);
      const vectors = await embedder.embedPassages(batch.map((entry) => entry.text));
      batch.forEach((entry, offset) => {
        const vector = vectors[offset];
        const input = inputs[entry.index];
        if (!vector || !input) throw new Error("Embedding worker returned too few vectors");
        input.vector = vector;
      });
    }
    // The session may have changed or left the index while vectors were computed.
    const current = this.store.getSession(agentId);
    if (!current) return;
    if (current.sourceMark !== session.sourceMark || current.messageCount < session.messageCount) {
      // Re-read from a new source: the message ids above no longer exist.
      this.rerunRequested = true;
      return;
    }
    this.store.replaceChunks({
      agentId,
      chunks: inputs,
      embeddedChars: session.textChars,
      model: this.spec.id,
    });
    this.vectorsByAgent.set(agentId, {
      vectors: inputs.map((input) => input.vector),
      messageIds: inputs.map((input) => input.messageId),
    });
    this.lastEmbeddedAt.set(agentId, this.now());
    if (current.textChars !== session.textChars) this.rerunRequested = true;
  }
}
