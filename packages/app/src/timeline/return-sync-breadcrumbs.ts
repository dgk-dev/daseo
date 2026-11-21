import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  shortTraceId,
  traceReturnSync,
  type ReturnSyncTraceValue,
} from "@/runtime/return-sync-trace";
import type { ViewedTimelineSyncTraceEvent } from "./viewed-timeline-sync";

/**
 * Daseo delta 140: what the session store holds for one chat. With the list's own line
 * (`agent-stream/strategy-native.tsx`) this tells data-stale (the end seq did not move) from
 * render-stale (the store moved, the list did not).
 */
export function describeStoredTimeline(
  serverId: string,
  agentId: string,
): Record<string, ReturnSyncTraceValue> {
  const session = useSessionStore.getState().sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  const items = timeline.status === "cold" ? [] : timeline.items;
  return {
    store: timeline.status,
    storeEndSeq: timeline.status === "synced" ? (timeline.range?.endSeq ?? null) : null,
    storeItems: items.length,
    storeHead: session?.agentStreamHead.get(agentId)?.length ?? 0,
  };
}

function formatAgentIds(agentIds: string[]): string {
  return agentIds.length === 0 ? "none" : agentIds.map((id) => shortTraceId(id)).join(",");
}

export function traceViewedTimelineSyncEvent(
  serverId: string,
  event: ViewedTimelineSyncTraceEvent,
): void {
  const server = shortTraceId(serverId);
  switch (event.type) {
    case "connection":
      traceReturnSync("connection", {
        server,
        change: event.change,
        epoch: event.connectionEpoch ?? null,
      });
      return;
    case "subscription-sent":
    case "subscription-acked":
    case "subscription-failed":
      traceReturnSync(event.type, { server, agents: formatAgentIds(event.agentIds) });
      return;
    case "catch-up-start":
      traceReturnSync("catch-up-start", {
        server,
        agent: shortTraceId(event.agentId),
        direction: event.request.direction,
        afterSeq: event.request.direction === "after" ? event.request.cursor.seq : null,
      });
      return;
    case "catch-up-finish":
      traceReturnSync("catch-up-finish", {
        server,
        agent: shortTraceId(event.agentId),
        outcome: event.outcome,
        pageEndSeq: event.endCursor?.seq ?? null,
        ...describeStoredTimeline(serverId, event.agentId),
      });
      return;
  }
}
