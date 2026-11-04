import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSearchMatchSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

// Daseo delta 79. The entry and request shapes as released before history
// search read message bodies: what a phone app that has not updated parses
// with, and what such an app sends.
const ReleasedHistoryEntrySchema = z.object({
  agent: z.object({ id: z.string() }).passthrough(),
  project: z.object({}).passthrough(),
  searchScore: z.number().optional(),
  searchMatches: z.array(AgentSearchMatchSchema).optional(),
  syncSeq: z.number().int().positive().optional(),
});
const ReleasedHistoryResponseSchema = z.object({
  type: z.literal("fetch_agent_history_response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(ReleasedHistoryEntrySchema),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      prevCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
    searchTruncated: z.boolean().optional(),
  }),
});

function historyEntry(extra: Record<string, unknown>) {
  return {
    agent: {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
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
      title: "Railway incident",
      labels: {},
    },
    project: {
      projectKey: "/tmp/repo",
      projectName: "repo",
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
    ...extra,
  };
}

const contentSearchResponse = {
  type: "fetch_agent_history_response",
  payload: {
    requestId: "req-1",
    entries: [
      historyEntry({
        searchScore: 20.5,
        searchSources: ["content", "semantic"],
        searchSnippet: {
          role: "assistant",
          text: "…rotated the Railway keys after the 보안 incident…",
          ranges: [
            { start: 16, length: 7 },
            { start: 36, length: 2 },
          ],
          seq: 42,
          anchorSeq: 40,
        },
      }),
    ],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    searchTruncated: false,
  },
};

describe("history search protocol (delta 79)", () => {
  it("parses a content-search history response with snippets", () => {
    const parsed = SessionOutboundMessageSchema.parse(contentSearchResponse);
    if (parsed.type !== "fetch_agent_history_response") throw new Error(parsed.type);
    expect(parsed.payload.entries[0]?.searchSnippet).toEqual(
      contentSearchResponse.payload.entries[0]?.searchSnippet,
    );
    expect(parsed.payload.entries[0]?.searchSources).toEqual(["content", "semantic"]);
  });

  it("passes the generated client validator, which is what the app runs", () => {
    const result = validateWSOutboundMessage({ type: "session", message: contentSearchResponse });
    expect(result.success).toBe(true);
  });

  it("still parses in an app built before the snippet fields existed", () => {
    const parsed = ReleasedHistoryResponseSchema.parse(contentSearchResponse);
    expect(parsed.payload.entries[0]?.agent.id).toBe("agent-1");
    expect(parsed.payload.entries[0]?.searchScore).toBe(20.5);
  });

  it("accepts a snippet read from a session file, which has no timeline rows", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      ...contentSearchResponse,
      payload: {
        ...contentSearchResponse.payload,
        entries: [
          historyEntry({
            searchSnippet: { role: "user", text: "규칙 정리", ranges: [] },
          }),
        ],
      },
    });
    if (parsed.type !== "fetch_agent_history_response") throw new Error(parsed.type);
    expect(parsed.payload.entries[0]?.searchSnippet?.seq).toBeUndefined();
  });

  it("parses the history request an older app sends, which carries no sub-agent flag", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "fetch_agent_history_request",
      requestId: "req-old",
      search: "railway",
      page: { limit: 200 },
    });
    if (parsed.type !== "fetch_agent_history_request") throw new Error(parsed.type);
    expect(parsed.includeSubagents).toBeUndefined();
  });

  it("parses the history request a new app sends to include sub-agents", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "fetch_agent_history_request",
      requestId: "req-new",
      includeSubagents: true,
    });
    if (parsed.type !== "fetch_agent_history_request") throw new Error(parsed.type);
    expect(parsed.includeSubagents).toBe(true);
  });

  it("round-trips the search status and AI rank RPCs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.history.get_search_status.request",
        requestId: "status-1",
      }).type,
    ).toBe("agent.history.get_search_status.request");
    const status = {
      type: "agent.history.get_search_status.response",
      payload: {
        requestId: "status-1",
        status: {
          keyword: { state: "indexing", indexedSessions: 12, totalSessions: 540 },
          semantic: {
            state: "downloading",
            embeddedSessions: 0,
            totalSessions: 540,
            downloadedBytes: 1024,
            totalBytes: 135_000_000,
            error: null,
          },
        },
      },
    };
    expect(SessionOutboundMessageSchema.parse(status)).toEqual(status);
    expect(validateWSOutboundMessage({ type: "session", message: status }).success).toBe(true);

    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.history.ai_rank.request",
        requestId: "rank-1",
        query: "보안 사고 키 교체",
        agentIds: ["a", "b"],
      }).type,
    ).toBe("agent.history.ai_rank.request");
    const failed = {
      type: "agent.history.ai_rank.response",
      payload: {
        requestId: "rank-1",
        agentIds: null,
        error: { code: "timeout", message: "No answer within 20 s" },
      },
    };
    expect(SessionOutboundMessageSchema.parse(failed)).toEqual(failed);
    expect(validateWSOutboundMessage({ type: "session", message: failed }).success).toBe(true);
  });

  it("reads the feature flags as absent on an older daemon", () => {
    const features = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: {},
    }).features;
    expect(features?.agentHistorySubagentFilter).toBeUndefined();
    expect(features?.agentHistoryContentSearch).toBeUndefined();
    expect(features?.agentHistoryAiRank).toBeUndefined();
  });
});
