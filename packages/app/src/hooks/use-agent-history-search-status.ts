import type { AgentHistorySearchStatus } from "@getpaseo/protocol/messages";
import { useEffect, useMemo, useRef, useState } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Daseo delta 79: how far each host's History search index has come, polled
 * while the owner is searching and the index is still building. The first
 * build reads every session once (a few minutes) and the semantic model
 * downloads once; until then results are partial, and the screen says so.
 */

const POLL_INTERVAL_MS = 3_000;

export interface AgentHistorySearchProgress {
  keywordIndexing: { indexed: number; total: number } | null;
  semantic:
    | { state: "downloading"; percent: number }
    | { state: "indexing"; embedded: number; total: number }
    | { state: "ready" | "failed" | "off" };
}

/** Folds several hosts into what one status line can say. Unknown states read as off. */
export function summarizeAgentHistorySearchStatus(
  statuses: readonly AgentHistorySearchStatus[],
): AgentHistorySearchProgress | null {
  if (statuses.length === 0) return null;
  const indexing = statuses.filter((status) => status.keyword.state === "indexing");
  const keywordIndexing =
    indexing.length > 0
      ? {
          indexed: statuses.reduce((total, status) => total + status.keyword.indexedSessions, 0),
          total: statuses.reduce((total, status) => total + status.keyword.totalSessions, 0),
        }
      : null;
  const semantics = statuses.map((status) => status.semantic);
  const downloading = semantics.filter((semantic) => semantic.state === "downloading");
  if (downloading.length > 0) {
    const downloaded = downloading.reduce(
      (total, semantic) => total + (semantic.downloadedBytes ?? 0),
      0,
    );
    const size = downloading.reduce((total, semantic) => total + (semantic.totalBytes ?? 0), 0);
    return {
      keywordIndexing,
      semantic: {
        state: "downloading",
        percent: size > 0 ? Math.floor((downloaded / size) * 100) : 0,
      },
    };
  }
  if (semantics.some((semantic) => semantic.state === "indexing")) {
    return {
      keywordIndexing,
      semantic: {
        state: "indexing",
        embedded: semantics.reduce((total, semantic) => total + semantic.embeddedSessions, 0),
        total: semantics.reduce((total, semantic) => total + semantic.totalSessions, 0),
      },
    };
  }
  if (semantics.some((semantic) => semantic.state === "failed")) {
    return { keywordIndexing, semantic: { state: "failed" } };
  }
  if (semantics.some((semantic) => semantic.state === "ready")) {
    return { keywordIndexing, semantic: { state: "ready" } };
  }
  return { keywordIndexing, semantic: { state: "off" } };
}

function isSettled(progress: AgentHistorySearchProgress | null): boolean {
  if (!progress) return false;
  return (
    progress.keywordIndexing === null &&
    progress.semantic.state !== "downloading" &&
    progress.semantic.state !== "indexing"
  );
}

export function useAgentHistorySearchStatus(input: {
  serverIds: readonly string[];
  enabled: boolean;
  /** Called once the index finishes building, so shown results can catch up. */
  onSettled: () => void;
}): AgentHistorySearchProgress | null {
  const [statusByServerId, setStatusByServerId] = useState<
    Record<string, AgentHistorySearchStatus>
  >({});
  const onSettledRef = useRef(input.onSettled);
  onSettledRef.current = input.onSettled;
  const serverKey = input.serverIds.join("\n");

  useEffect(() => {
    if (!input.enabled || serverKey.length === 0) return;
    const serverIds = serverKey.split("\n");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasSettled: boolean | null = null;
    const poll = async () => {
      const results = await Promise.all(
        serverIds.map(async (serverId) => {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) return null;
          try {
            const payload = await client.getAgentHistorySearchStatus();
            return [serverId, payload.status] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, AgentHistorySearchStatus> = {};
      for (const result of results) if (result) next[result[0]] = result[1];
      setStatusByServerId(next);
      const settled = isSettled(summarizeAgentHistorySearchStatus(Object.values(next)));
      if (wasSettled === false && settled) onSettledRef.current();
      wasSettled = settled;
      if (!settled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [input.enabled, serverKey]);

  return useMemo(() => {
    if (!input.enabled) return null;
    const statuses = input.serverIds.flatMap((serverId) => {
      const status = statusByServerId[serverId];
      return status ? [status] : [];
    });
    return summarizeAgentHistorySearchStatus(statuses);
  }, [input.enabled, input.serverIds, statusByServerId]);
}
