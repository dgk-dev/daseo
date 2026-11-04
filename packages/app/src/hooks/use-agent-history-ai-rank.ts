import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { agentHistoryRowKey } from "@/hooks/use-agent-history";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Daseo delta 79: "AI search" re-orders the best matches with a small model on
 * the host. It runs only when the owner asks; the plain results stay on screen
 * while it works, and a failure keeps them with a quiet notice.
 */

/** How many of the best matches the model sees. */
export const AI_RANK_CANDIDATES = 20;
const AI_RANK_TIMEOUT_MS = 30_000;

export type AgentHistoryAiRankState =
  | { status: "idle" }
  | { status: "ranking" }
  | { status: "ranked"; order: string[] }
  | { status: "failed" };

/**
 * Each host ranks only its own rows. Every host keeps the slots its rows held
 * in the merged list and fills them in its AI order, so one host's ranking can
 * never push another host's rows around.
 */
export function mergeHostRankings(
  topKeys: readonly string[],
  serverIdOf: (key: string) => string,
  rankedKeysByServerId: ReadonlyMap<string, readonly string[]>,
): string[] {
  const cursors = new Map<string, number>();
  return topKeys.map((key) => {
    const serverId = serverIdOf(key);
    const ranked = rankedKeysByServerId.get(serverId);
    if (!ranked) return key;
    const index = cursors.get(serverId) ?? 0;
    cursors.set(serverId, index + 1);
    return ranked[index] ?? key;
  });
}

/** The ranked rows first, in the model's order; every other row keeps its place after them. */
export function applyAiOrder(
  agents: readonly AggregatedAgent[],
  order: readonly string[],
): AggregatedAgent[] {
  const byKey = new Map(agents.map((agent) => [agentHistoryRowKey(agent), agent]));
  const ranked = order.flatMap((key) => {
    const agent = byKey.get(key);
    return agent ? [agent] : [];
  });
  const rankedKeys = new Set(order);
  return [...ranked, ...agents.filter((agent) => !rankedKeys.has(agentHistoryRowKey(agent)))];
}

export function useAgentHistoryAiRank(input: {
  query: string;
  agents: readonly AggregatedAgent[];
}): {
  state: AgentHistoryAiRankState;
  orderedAgents: AggregatedAgent[];
  run: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<AgentHistoryAiRankState>({ status: "idle" });
  const requestIdRef = useRef(0);
  const { query, agents } = input;

  // A ranking answers one query; a new query starts over with the plain order.
  useEffect(() => {
    requestIdRef.current += 1;
    setState({ status: "idle" });
  }, [query]);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    setState({ status: "idle" });
  }, []);

  const run = useCallback(() => {
    const top = agents.slice(0, AI_RANK_CANDIDATES);
    if (!query || top.length < 2) return;
    const requestId = ++requestIdRef.current;
    setState({ status: "ranking" });
    const idsByServerId = new Map<string, string[]>();
    for (const agent of top) {
      idsByServerId.set(agent.serverId, [...(idsByServerId.get(agent.serverId) ?? []), agent.id]);
    }
    void Promise.all(
      [...idsByServerId.entries()].map(async ([serverId, agentIds]) => {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(`Host ${serverId} is not connected`);
        const payload = await client.rankAgentHistoryWithAi({
          query,
          agentIds,
          timeout: AI_RANK_TIMEOUT_MS,
        });
        if (!payload.agentIds) throw new Error(payload.error?.message ?? "AI ranking failed");
        return [
          serverId,
          payload.agentIds.map((id) => agentHistoryRowKey({ serverId, id })),
        ] as const;
      }),
    )
      .then((ranked) => {
        if (requestId !== requestIdRef.current) return;
        const serverIdByKey = new Map(
          top.map((agent) => [agentHistoryRowKey(agent), agent.serverId]),
        );
        const order = mergeHostRankings(
          top.map((agent) => agentHistoryRowKey(agent)),
          (key) => serverIdByKey.get(key) ?? "",
          new Map(ranked),
        );
        setState({ status: "ranked", order });
        return undefined;
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        console.warn("History AI search failed", error);
        setState({ status: "failed" });
      });
  }, [agents, query]);

  const orderedAgents = useMemo(
    () => (state.status === "ranked" ? applyAiOrder(agents, state.order) : [...agents]),
    [agents, state],
  );

  return { state, orderedAgents, run, reset };
}
