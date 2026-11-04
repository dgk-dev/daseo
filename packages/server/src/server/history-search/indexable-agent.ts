import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import type { IndexableAgent } from "./history-indexer.js";

export interface HistoryAgentSource {
  id: string;
  provider: string;
  internal?: boolean;
  labels?: Record<string, string> | null;
  persistence?: { provider: string; nativeHandle?: string | null } | null;
}

/**
 * The agents History search indexes: the ones History lists. Internal agents
 * (metadata generation) and agents another agent created are left out, so a
 * sub-agent's text never surfaces in History.
 */
export function toIndexableAgent(agent: HistoryAgentSource): IndexableAgent | null {
  if (agent.internal || isDelegatedAgent(agent)) return null;
  const handle = agent.persistence?.nativeHandle ?? null;
  const isPi = (agent.persistence?.provider ?? agent.provider) === "pi";
  return {
    id: agent.id,
    piSessionFile: isPi && handle?.endsWith(".jsonl") ? handle : null,
  };
}
