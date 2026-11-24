import { useEffect, useLayoutEffect, useState } from "react";
import { AppState } from "react-native";
import { shortTraceId, traceReturnSync } from "@/runtime/return-sync-trace";
import type { ViewedTimelineUiBridge } from "./viewed-timeline-sync";

/**
 * Daseo delta 150: each mounted screen owns its own visible-agent source. The source id used to be
 * the workspace key, which an old and a new instance of the same workspace screen share. When the
 * screen remounted in one commit (fold/unfold, a desktop window crossing the compact width), React
 * ran the new instance's layout effect (publish) before the old instance's passive cleanup (clear),
 * so the clear deleted the new instance's ids and the shown chat dropped out of the subscription on
 * the next reconnect. A per-instance token keeps one instance from ever clearing another's ids.
 */
let nextSourceToken = 0;

function createSourceToken(): number {
  nextSourceToken += 1;
  return nextSourceToken;
}

// Trace bookkeeping only: what each sync has been told, per source, and the last traced line.
const publishedBySync = new WeakMap<ViewedTimelineUiBridge, Map<string, string[]>>();
const lastTraceBySync = new WeakMap<ViewedTimelineUiBridge, string>();

function recordAndTrace(
  sync: ViewedTimelineUiBridge,
  sourceId: string,
  agentIds: readonly string[],
): void {
  let published = publishedBySync.get(sync);
  if (!published) {
    published = new Map();
    publishedBySync.set(sync, published);
  }
  if (agentIds.length === 0) published.delete(sourceId);
  else published.set(sourceId, [...agentIds]);
  if (AppState.currentState !== "active") return;
  const agents = [...new Set([...published.values()].flat())];
  const line = `${agents.join(",")}|${published.size}`;
  if (lastTraceBySync.get(sync) === line) return;
  lastTraceBySync.set(sync, line);
  traceReturnSync("visible-sources", {
    agents: agents.length === 0 ? "none" : agents.map((id) => shortTraceId(id)).join(","),
    sources: published.size,
  });
}

function publish(
  sync: ViewedTimelineUiBridge,
  sourceId: string,
  agentIds: readonly string[],
): void {
  sync.replaceVisibleAgentIds(sourceId, [...agentIds]);
  recordAndTrace(sync, sourceId, agentIds);
}

export function usePublishVisibleAgentIds(
  sync: ViewedTimelineUiBridge | null,
  persistenceKey: string | null,
  agentIds: string[],
): void {
  const [sourceToken] = useState(createSourceToken);
  const sourceId = persistenceKey ? `${persistenceKey}#${sourceToken}` : null;

  // Publish before paint so the first frame of a newly shown chat is already in the hot set.
  useLayoutEffect(() => {
    if (!sourceId || !sync) return;
    publish(sync, sourceId, agentIds);
  }, [agentIds, sourceId, sync]);

  // Clear on unmount, key change, or sync replacement only; never between ordinary re-renders,
  // because an empty list cancels in-flight catch-ups for these agents.
  useEffect(() => {
    if (!sourceId || !sync) return;
    return () => publish(sync, sourceId, []);
  }, [sourceId, sync]);
}
