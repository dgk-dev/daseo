import path from "node:path";
import type pino from "pino";
import type {
  AgentHistorySearchStatus,
  AgentSearchMatch,
  AgentSearchSnippet,
} from "@getpaseo/protocol/messages";
import { tokenizeQuery } from "@getpaseo/protocol/search/text-match";
import {
  describeAgentHistoryMatches,
  rankAgentHistoryCandidates,
  type AgentHistorySearchCandidate,
} from "../agent-history-search.js";
import type { HistoryAiRanker } from "./history-ai-ranker.js";
import {
  buildContentSnippet,
  buildMessageSnippet,
  rankSessionsByContent,
} from "./history-content-ranking.js";
import { HistoryIndexStore } from "./history-index-store.js";
import { HistoryIndexer, type IndexableAgent } from "./history-indexer.js";
import { fuseRankings, fusedScoreToSearchScore } from "./rank-fusion.js";
import { HISTORY_EMBEDDING_MODEL } from "./semantic/embedding-model.js";
import {
  HistorySemanticIndex,
  type HistoryEmbedder,
  type SemanticMatch,
} from "./semantic/history-semantic-index.js";

/**
 * History search (Daseo delta 79): title, message-body keyword, and semantic
 * rankings fused by reciprocal rank. The session hands over the candidates
 * History would list; this ranks them, explains each result with a snippet,
 * and owns the index, the embedding model, and the optional AI re-rank.
 */

export interface HistorySearchResult<T extends AgentHistorySearchCandidate> {
  candidate: T;
  searchScore: number;
  searchMatches: AgentSearchMatch[];
  searchSnippet?: AgentSearchSnippet;
  searchSources: string[];
}

/** Daemon config: null or absent turns History content search off. */
export interface HistorySearchSettings {
  /** Rank by meaning with the local embedding model (downloaded once). */
  semantic: boolean;
}

export interface HistorySearchServiceOptions {
  paseoHome: string;
  logger: pino.Logger;
  listRootAgents: () => Promise<IndexableAgent[]>;
  resolveRootAgent: (agentId: string) => Promise<IndexableAgent | null>;
  /** False keeps search keyword-only and never downloads the model. */
  semanticEnabled: boolean;
  createEmbedder: (modelDir: string) => HistoryEmbedder;
  aiRanker: HistoryAiRanker | null;
  /** Overrides for tests. */
  indexPath?: string;
  modelsDir?: string;
  timelinesDir?: string;
  ensureModel?: ConstructorParameters<typeof HistorySemanticIndex>[0]["ensureModel"];
  aiRankTimeoutMs?: number;
}

export type HistoryAiRankOutcome =
  | { ok: true; agentIds: string[] }
  | { ok: false; code: "unavailable" | "timeout" | "failed"; message: string };

const DEFAULT_AI_RANK_TIMEOUT_MS = 20_000;

export class HistorySearchService {
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startRun: Promise<void> | null = null;
  private stopped = false;

  private constructor(
    private readonly store: HistoryIndexStore,
    private readonly indexer: HistoryIndexer,
    private readonly semantic: HistorySemanticIndex | null,
    private readonly aiRanker: HistoryAiRanker | null,
    private readonly aiRankTimeoutMs: number,
    private readonly logger: pino.Logger,
  ) {}

  /** Opens the index. Rejects when this runtime cannot host it (no node:sqlite). */
  static async create(options: HistorySearchServiceOptions): Promise<HistorySearchService> {
    const logger = options.logger.child({ module: "history-search" });
    const store = await HistoryIndexStore.open(
      options.indexPath ?? path.join(options.paseoHome, "search", "history-index.sqlite"),
    );
    const semantic = options.semanticEnabled
      ? new HistorySemanticIndex({
          store,
          spec: HISTORY_EMBEDDING_MODEL,
          modelsDir: options.modelsDir ?? path.join(options.paseoHome, "models", "history-search"),
          logger,
          createEmbedder: options.createEmbedder,
          ...(options.ensureModel ? { ensureModel: options.ensureModel } : {}),
        })
      : null;
    const indexer = new HistoryIndexer({
      store,
      timelinesDir: options.timelinesDir ?? path.join(options.paseoHome, "timelines"),
      listRootAgents: options.listRootAgents,
      resolveRootAgent: options.resolveRootAgent,
      logger,
      onSessionChanged: (agentId) => semantic?.notifySessionChanged(agentId),
    });
    return new HistorySearchService(
      store,
      indexer,
      semantic,
      options.aiRanker,
      options.aiRankTimeoutMs ?? DEFAULT_AI_RANK_TIMEOUT_MS,
      logger,
    );
  }

  get aiRankAvailable(): boolean {
    return this.aiRanker !== null;
  }

  /**
   * Builds the index in the background. The model download starts after the
   * keyword pass so the first build reads disk and network one at a time.
   */
  start(options: { delayMs?: number } = {}): void {
    if (this.stopped || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.stopped) this.runStart();
    }, options.delayMs ?? 0);
    this.startTimer.unref?.();
  }

  private runStart(): void {
    this.startRun = this.indexer
      .start()
      .catch((error) => this.logger.warn({ err: error }, "History index pass failed"))
      .then(() => this.semantic?.start())
      .catch((error) => this.logger.warn({ err: error }, "History semantic index failed"));
  }

  /** Waits for queued indexing; tests only. */
  async idle(): Promise<void> {
    await this.startRun;
    await this.indexer.idle();
    await this.semantic?.idle();
  }

  notifyTimelineChanged(agentId: string): void {
    this.indexer.notifyTimelineChanged(agentId);
  }

  status(): AgentHistorySearchStatus {
    const keyword = this.indexer.status();
    const semantic = this.semantic?.status() ?? {
      state: "disabled" as const,
      embeddedSessions: 0,
      totalSessions: 0,
    };
    return {
      keyword,
      semantic: {
        state: semantic.state,
        embeddedSessions: semantic.embeddedSessions,
        totalSessions: semantic.totalSessions,
        ...(semantic.state === "downloading"
          ? { downloadedBytes: semantic.downloadedBytes, totalBytes: semantic.totalBytes }
          : {}),
        ...(semantic.state === "failed" ? { error: semantic.error } : {}),
      },
    };
  }

  /**
   * Every candidate any signal matched, best first, with the explanation for
   * each of the first `describeLimit` rows (the rows that will be sent).
   */
  async search<T extends AgentHistorySearchCandidate>(input: {
    query: string;
    candidates: readonly T[];
    compareTies: (left: T, right: T) => number;
    describeLimit: number;
  }): Promise<HistorySearchResult<T>[]> {
    const { query, candidates } = input;
    const tokens = tokenizeQuery(query);
    const byId = new Map(candidates.map((candidate) => [candidate.agent.id, candidate]));
    const candidateIds = new Set(byId.keys());

    const title = rankAgentHistoryCandidates(query, candidates, input.compareTies);
    const content = rankSessionsByContent({ store: this.store, tokens, candidateIds });
    const semantic = (await this.semantic?.rank({ query, candidateIds })) ?? [];
    const semanticById = new Map<string, SemanticMatch>(
      semantic.map((match) => [match.agentId, match]),
    );

    const fused = fuseRankings([
      { source: "title", ids: title.map((result) => result.candidate.agent.id) },
      { source: "content", ids: content.matches.map((match) => match.agentId) },
      { source: "semantic", ids: semantic.map((match) => match.agentId) },
    ]);
    const ordered = fused
      .flatMap((rank) => {
        const candidate = byId.get(rank.id);
        return candidate ? [{ rank, candidate }] : [];
      })
      .sort((left, right) => {
        if (left.rank.score !== right.rank.score) return right.rank.score - left.rank.score;
        return input.compareTies(left.candidate, right.candidate);
      });

    return ordered.map(({ rank, candidate }, index) => {
      const result: HistorySearchResult<T> = {
        candidate,
        searchScore: fusedScoreToSearchScore(rank.score),
        searchMatches: [],
        searchSources: rank.sources,
      };
      if (index >= input.describeLimit) return result;
      result.searchMatches = describeAgentHistoryMatches(query, candidate);
      const snippet = this.describe({
        agentId: rank.id,
        tokens,
        idfByToken: content.idfByToken,
        contentMatched: rank.sources.includes("content"),
        semantic: semanticById.get(rank.id) ?? null,
      });
      if (snippet) result.searchSnippet = snippet;
      return result;
    });
  }

  private describe(input: {
    agentId: string;
    tokens: readonly string[];
    idfByToken: ReadonlyMap<string, number>;
    contentMatched: boolean;
    semantic: SemanticMatch | null;
  }): AgentSearchSnippet | null {
    if (input.contentMatched) {
      const snippet = buildContentSnippet({
        store: this.store,
        agentId: input.agentId,
        tokens: input.tokens,
        idfByToken: input.idfByToken,
      });
      if (snippet) return snippet;
    }
    if (input.semantic) {
      const message = this.store.getMessage(input.semantic.messageId);
      if (message && message.agentId === input.agentId) return buildMessageSnippet(message);
    }
    return null;
  }

  /** Re-orders `candidates` (best first) with the AI ranker, within the timeout. */
  async aiRank(input: {
    query: string;
    candidates: readonly { agentId: string; title: string | null; updatedAt: string }[];
  }): Promise<HistoryAiRankOutcome> {
    if (!this.aiRanker) {
      return { ok: false, code: "unavailable", message: "No ranking model is configured" };
    }
    if (input.candidates.length < 2) {
      return { ok: true, agentIds: input.candidates.map((candidate) => candidate.agentId) };
    }
    const tokens = tokenizeQuery(input.query);
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.agentId));
    const { idfByToken } = rankSessionsByContent({ store: this.store, tokens, candidateIds });
    const cards = input.candidates.map((candidate) => ({
      ...candidate,
      firstUserMessage: this.store.getFirstMessage(candidate.agentId, "user")?.text ?? null,
      lastAnswer: this.store.getLastMessage(candidate.agentId, "assistant")?.text ?? null,
      snippet:
        buildContentSnippet({ store: this.store, agentId: candidate.agentId, tokens, idfByToken })
          ?.text ?? null,
    }));

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<HistoryAiRankOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            code: "timeout",
            message: `No ranking within ${Math.round(this.aiRankTimeoutMs / 1000)} s`,
          }),
        this.aiRankTimeoutMs,
      );
    });
    const ranking = this.aiRanker.rank({ query: input.query, candidates: cards }).then(
      (agentIds): HistoryAiRankOutcome => ({ ok: true, agentIds }),
      (error: unknown): HistoryAiRankOutcome => ({
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    try {
      return await Promise.race([ranking, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.indexer.stop();
    this.semantic?.stop();
    await this.startRun;
    await this.indexer.idle();
    await this.semantic?.idle();
    this.store.close();
  }
}
