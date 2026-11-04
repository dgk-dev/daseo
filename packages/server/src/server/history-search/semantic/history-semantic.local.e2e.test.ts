import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentHistorySearchCandidate } from "../../agent-history-search.js";
import { HistorySearchService } from "../history-search-service.js";
import {
  HISTORY_FIXTURE_QUERIES,
  HISTORY_FIXTURE_SESSIONS,
} from "../test-utils/history-search-fixture.js";
import { writeFixtureTimelines } from "../test-utils/write-history-fixture.js";
import {
  embeddingModelDirectory,
  ensureEmbeddingModel,
  HISTORY_EMBEDDING_MODEL,
  isEmbeddingModelPresent,
} from "./embedding-model.js";
import { EmbeddingWorkerClient } from "./embedding-worker-client.js";
import { createWorkerEmbedder } from "./worker-embedder.js";

/**
 * Runs the real multilingual-e5-small model in its worker process. Skipped
 * unless the model is installed (`PASEO_HISTORY_MODELS_DIR`, default
 * ~/.paseo/models/history-search) or `PASEO_HISTORY_E2E_DOWNLOAD=1` allows a
 * 135 MB download.
 */
const modelsDir =
  process.env.PASEO_HISTORY_MODELS_DIR ??
  path.join(homedir(), ".paseo", "models", "history-search");
const shouldDownload = process.env.PASEO_HISTORY_E2E_DOWNLOAD === "1";
const modelPresent = await isEmbeddingModelPresent({ modelsDir, spec: HISTORY_EMBEDDING_MODEL });
const describeWithModel = modelPresent || shouldDownload ? describe : describe.skip;

const logger = pino({ level: "silent" });

function candidate(sessionId: string, title: string, index: number): AgentHistorySearchCandidate {
  const updatedAt = new Date(Date.UTC(2026, 9, 1 + index)).toISOString();
  return {
    agent: {
      id: sessionId,
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
      title,
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

describeWithModel("History semantic search with the real model", () => {
  let home: string;
  let service: HistorySearchService;
  let rssGrowthMb = 0;

  beforeAll(async () => {
    await ensureEmbeddingModel({ modelsDir, spec: HISTORY_EMBEDDING_MODEL });
    home = await mkdtemp(path.join(tmpdir(), "paseo-history-semantic-"));
    await writeFixtureTimelines({
      timelinesDir: path.join(home, "timelines"),
      sessions: HISTORY_FIXTURE_SESSIONS,
    });
    const roots = HISTORY_FIXTURE_SESSIONS.map((session) => ({
      id: session.id,
      piSessionFile: null,
    }));
    service = await HistorySearchService.create({
      paseoHome: home,
      modelsDir,
      logger,
      listRootAgents: async () => roots,
      resolveRootAgent: async (agentId) => roots.find((root) => root.id === agentId) ?? null,
      semanticEnabled: true,
      createEmbedder: (modelDir) =>
        createWorkerEmbedder({ modelDir, spec: HISTORY_EMBEDDING_MODEL, logger }),
      aiRanker: null,
    });
    const rssBefore = process.memoryUsage().rss;
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.idle();
    rssGrowthMb = (process.memoryUsage().rss - rssBefore) / 1e6;
  }, 300_000);

  afterAll(async () => {
    await service?.stop();
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("embeds every session out of process", () => {
    expect(service.status().semantic).toMatchObject({
      state: "ready",
      embeddedSessions: HISTORY_FIXTURE_SESSIONS.length,
    });
    // The 118 MB model and ONNX Runtime live in the worker, not here.
    expect(rssGrowthMb).toBeLessThan(100);
  });

  test("ranks each paraphrase's session in the top 5 though they share no word", async () => {
    const candidates = HISTORY_FIXTURE_SESSIONS.map((session, index) =>
      candidate(session.id, session.title, index),
    );
    const placements: string[] = [];
    for (const query of HISTORY_FIXTURE_QUERIES) {
      if (!query.paraphrase) continue;
      const results = await service.search({
        query: query.paraphrase,
        candidates,
        compareTies: () => 0,
        describeLimit: 5,
      });
      const rank = results.findIndex((result) => result.candidate.agent.id === query.target);
      placements.push(`${query.paraphrase} → ${rank + 1}`);
      expect(rank, placements.join("\n")).toBeGreaterThanOrEqual(0);
      expect(rank, placements.join("\n")).toBeLessThan(5);
      expect(results[rank]?.searchSources).toContain("semantic");
    }
  }, 120_000);

  test("stops the worker after it has been idle", async () => {
    const modelDir = embeddingModelDirectory(modelsDir, HISTORY_EMBEDDING_MODEL);
    const client = new EmbeddingWorkerClient({
      logger,
      idleTtlMs: 200,
      model: {
        modelPath: path.join(modelDir, HISTORY_EMBEDDING_MODEL.files.model.path),
        tokenizerPath: path.join(modelDir, HISTORY_EMBEDDING_MODEL.files.tokenizer.path),
        tokenizerConfigPath: path.join(
          modelDir,
          HISTORY_EMBEDDING_MODEL.files.tokenizerConfig.path,
        ),
        maxTokens: HISTORY_EMBEDDING_MODEL.maxTokens,
      },
    });
    try {
      const [vector] = await client.embed({
        prefix: HISTORY_EMBEDDING_MODEL.queryPrefix,
        texts: ["어린이집 신청"],
        timeoutMs: 30_000,
      });
      expect(vector?.length).toBe(HISTORY_EMBEDDING_MODEL.dimensions);
      expect(client.isRunning).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(client.isRunning).toBe(false);
    } finally {
      client.shutdown();
    }
  }, 60_000);
});
