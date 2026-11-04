import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistorySearchCandidate } from "../agent-history-search.js";
import type { HistoryAiRanker } from "./history-ai-ranker.js";
import { DEFAULT_SEMANTIC_BUDGET_MS, HistorySearchService } from "./history-search-service.js";
import type { HistoryEmbedder } from "./semantic/history-semantic-index.js";
import {
  HISTORY_FIXTURE_QUERIES,
  HISTORY_FIXTURE_SESSIONS,
  type FixtureSession,
} from "./test-utils/history-search-fixture.js";
import { writeFixtureTimelines } from "./test-utils/write-history-fixture.js";

const logger = pino({ level: process.env.HS_LOG ?? "silent" });
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function candidateFor(session: FixtureSession, index: number): AgentHistorySearchCandidate {
  const updatedAt = new Date(Date.UTC(2026, 9, 1 + index)).toISOString();
  return {
    agent: {
      id: session.id,
      provider: "codex",
      cwd: "/tmp/repo",
      model: null,
      createdAt: updatedAt,
      updatedAt,
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: session.title,
      labels: {},
    },
    project: {
      projectKey: "/tmp/repo",
      projectName: "repo",
      workspaceName: "repo",
      checkout: {
        cwd: "/tmp/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  } as AgentHistorySearchCandidate;
}

const CANDIDATES = HISTORY_FIXTURE_SESSIONS.map(candidateFor);

/**
 * Stands in for e5 in plumbing tests: words map to concepts, so a paraphrase
 * that shares no word with a session can still land next to it. Model quality
 * is covered by history-semantic.local.e2e.test.ts against the real model.
 */
const CONCEPTS: Record<string, string> = {
  어린이집: "childcare",
  보육시설: "childcare",
  "0세반": "childcare",
  애기: "childcare",
  입소: "childcare",
};

function conceptVector(text: string): Float32Array {
  const vector = new Float32Array(4);
  vector[3] = 0.05;
  for (const [word, concept] of Object.entries(CONCEPTS)) {
    if (text.includes(word) && concept === "childcare") vector[0] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

const fakeEmbedder: HistoryEmbedder = {
  embedPassages: async (texts) => texts.map(conceptVector),
  embedQuery: async (text) => conceptVector(text),
  shutdown: () => undefined,
};

async function createService(
  options: {
    semantic?: "ready" | "missing" | "off";
    embedder?: HistoryEmbedder;
    aiRanker?: HistoryAiRanker | null;
    aiRankTimeoutMs?: number;
  } = {},
): Promise<HistorySearchService> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-history-search-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFixtureTimelines({
    timelinesDir: path.join(home, "timelines"),
    sessions: HISTORY_FIXTURE_SESSIONS,
  });
  const roots = HISTORY_FIXTURE_SESSIONS.map((session) => ({
    id: session.id,
    piSessionFile: null,
  }));
  const semantic = options.semantic ?? "off";
  const service = await HistorySearchService.create({
    paseoHome: home,
    logger,
    listRootAgents: async () => roots,
    resolveRootAgent: async (agentId) => roots.find((root) => root.id === agentId) ?? null,
    semanticEnabled: semantic !== "off",
    createEmbedder: () => options.embedder ?? fakeEmbedder,
    ensureModel: async ({ modelsDir }) => {
      if (semantic === "missing") throw new Error("offline");
      return modelsDir;
    },
    aiRanker: options.aiRanker ?? null,
    ...(options.aiRankTimeoutMs ? { aiRankTimeoutMs: options.aiRankTimeoutMs } : {}),
  });
  cleanups.push(() => service.stop());
  service.start();
  // start() defers to a timer; let it fire, then wait for the passes.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.idle();
  return service;
}

function compareTies(left: AgentHistorySearchCandidate, right: AgentHistorySearchCandidate) {
  return Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt);
}

async function searchIds(service: HistorySearchService, query: string): Promise<string[]> {
  const results = await service.search({
    query,
    candidates: CANDIDATES,
    compareTies,
    describeLimit: 200,
  });
  return results.map((result) => result.candidate.agent.id);
}

describe("HistorySearchService", () => {
  test("finds a session by words said only in its messages, with a marked snippet to open at", async () => {
    const service = await createService();
    const [first] = await service.search({
      query: "세금계산서",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });

    expect(first?.candidate.agent.id).toBe("distractor-invoice");
    expect(first?.searchSources).toEqual(["content"]);
    expect(first?.searchMatches).toEqual([]);
    const snippet = first?.searchSnippet;
    expect(snippet).toMatchObject({ role: "user", text: "세금계산서 자동 발행 규칙 정리해줘" });
    expect(snippet?.ranges).toEqual([{ start: 0, length: "세금계산서".length }]);
    // Row 2 is the prompt (row 1 is the system wake); it also starts the turn.
    expect(snippet).toMatchObject({ seq: 2, anchorSeq: 2 });
  });

  test("answers a 2-syllable Korean word and a mixed Korean/English query", async () => {
    const service = await createService();
    expect((await searchIds(service, "규칙"))[0]).toBe("distractor-invoice");
    const [railway] = await service.search({
      query: "railway 보안",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });
    expect(railway?.candidate.agent.id).toBe("railway-incident");
    const marked = (railway?.searchSnippet?.ranges ?? []).map((range) =>
      railway?.searchSnippet?.text.slice(range.start, range.start + range.length).toLowerCase(),
    );
    expect(marked).toEqual(expect.arrayContaining(["railway", "보안"]));
  });

  test("points an answer's snippet at the prompt that started its turn", async () => {
    const service = await createService();
    const [result] = await service.search({
      query: "가상 인증기",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });
    expect(result?.candidate.agent.id).toBe("passkey");
    // Rows: 1 system, 2 user, 3 reasoning, 4 tool, 5 assistant.
    expect(result?.searchSnippet).toMatchObject({ role: "assistant", seq: 5, anchorSeq: 2 });
  });

  test("keeps the title signal: a title match ranks and is marked", async () => {
    const service = await createService();
    const [result] = await service.search({
      query: "terminal resize",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });
    expect(result?.candidate.agent.id).toBe("distractor-terminal");
    expect(result?.searchSources).toEqual(["title", "content"]);
    expect(result?.searchMatches.find((match) => match.field === "title")?.ranges).toEqual([
      { start: 0, length: "terminal".length },
      { start: 9, length: "resize".length },
    ]);
  });

  test("regression: every short query ranks its session first, every recalled sentence in the top 3", async () => {
    const service = await createService();
    const misses: string[] = [];
    for (const query of HISTORY_FIXTURE_QUERIES) {
      const shortIds = await searchIds(service, query.short);
      if (shortIds[0] !== query.target) misses.push(`short "${query.short}" → ${shortIds[0]}`);
      const longIds = await searchIds(service, query.long);
      if (!longIds.slice(0, 3).includes(query.target)) {
        misses.push(`long "${query.long}" → ${longIds.slice(0, 3).join(",")}`);
      }
    }
    expect(misses).toEqual([]);
  });

  test("adds semantic matches once the model is ready and says so", async () => {
    const service = await createService({ semantic: "ready" });
    expect(service.status().semantic).toMatchObject({
      state: "ready",
      embeddedSessions: HISTORY_FIXTURE_SESSIONS.length,
      totalSessions: HISTORY_FIXTURE_SESSIONS.length,
    });
    const [result] = await service.search({
      query: "애기 보육시설",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });
    expect(result?.candidate.agent.id).toBe("daycare");
    expect(result?.searchSources).toEqual(["semantic"]);
    // Matched by meaning only: a snippet to read, nothing to mark.
    expect(result?.searchSnippet?.ranges).toEqual([]);
    expect(result?.searchSnippet?.text.length).toBeGreaterThan(0);
  });

  test("answers within the semantic budget with keyword results when the query embedding is slow", async () => {
    let slowQueries = 0;
    const slowEmbedder: HistoryEmbedder = {
      embedPassages: async (texts) => texts.map(conceptVector),
      // A worker cold-starting from disk, re-forking after a crash, or busy behind passage
      // batches: far longer than any search may wait.
      embedQuery: (text) =>
        new Promise((resolve) => {
          slowQueries += 1;
          setTimeout(() => resolve(conceptVector(text)), 4_000).unref();
        }),
      shutdown: () => undefined,
    };
    const service = await createService({ semantic: "ready", embedder: slowEmbedder });
    expect(service.status().semantic.state).toBe("ready");

    const startedAt = Date.now();
    const results = await service.search({
      query: "어린이집",
      candidates: CANDIDATES,
      compareTies,
      describeLimit: 200,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(slowQueries).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_SEMANTIC_BUDGET_MS - 50);
    expect(elapsedMs).toBeLessThan(DEFAULT_SEMANTIC_BUDGET_MS + 500);
    expect(results[0]?.candidate.agent.id).toBe("daycare");
    expect(results[0]?.searchSnippet?.ranges.length).toBeGreaterThan(0);
    // The semantic signal was skipped, so no row claims it.
    expect(results.every((result) => !result.searchSources.includes("semantic"))).toBe(true);
  });

  test("searches keyword-only and reports why when the model cannot be fetched", async () => {
    const service = await createService({ semantic: "missing" });
    expect(service.status().semantic).toMatchObject({ state: "failed", error: "offline" });
    expect(await searchIds(service, "애기 보육시설")).not.toContain("daycare");
    expect((await searchIds(service, "어린이집"))[0]).toBe("daycare");
    expect(service.status().keyword).toEqual({
      state: "ready",
      indexedSessions: HISTORY_FIXTURE_SESSIONS.length,
      totalSessions: HISTORY_FIXTURE_SESSIONS.length,
    });
  });

  test("AI re-rank returns its order, and falls back on failure or timeout", async () => {
    const candidates = [
      { agentId: "daycare", title: "작업 01", updatedAt: "2026-10-01T00:00:00.000Z" },
      { agentId: "loan-plan", title: "작업 11", updatedAt: "2026-10-02T00:00:00.000Z" },
    ];
    const seen: string[][] = [];
    const reversing = await createService({
      aiRanker: {
        rank: async (input) => {
          seen.push(input.candidates.map((card) => card.firstUserMessage ?? ""));
          return input.candidates.map((card) => card.agentId).toReversed();
        },
      },
    });
    expect(await reversing.aiRank({ query: "대출", candidates })).toEqual({
      ok: true,
      agentIds: ["loan-plan", "daycare"],
    });
    // The ranker reads the session's own words from the index.
    expect(seen[0]?.[1]).toContain("마이너스 통장");

    const failing = await createService({
      aiRanker: {
        rank: async () => {
          throw new Error("no model answered");
        },
      },
    });
    expect(await failing.aiRank({ query: "대출", candidates })).toEqual({
      ok: false,
      code: "failed",
      message: "no model answered",
    });

    const hanging = await createService({
      aiRanker: { rank: () => new Promise<string[]>(() => undefined) },
      aiRankTimeoutMs: 30,
    });
    expect(await hanging.aiRank({ query: "대출", candidates })).toMatchObject({
      ok: false,
      code: "timeout",
    });

    const unconfigured = await createService({ aiRanker: null });
    expect(await unconfigured.aiRank({ query: "대출", candidates })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});
