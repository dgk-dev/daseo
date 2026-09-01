import type {
  AgentProvider,
  AgentProviderSelectionPolicy,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";

export type ProviderSelectionPolicyMap = Map<AgentProvider, AgentProviderSelectionPolicy>;

export function buildProviderSelectionPolicyMap(
  entries: readonly ProviderSnapshotEntry[] | undefined,
): ProviderSelectionPolicyMap {
  const policies: ProviderSelectionPolicyMap = new Map();
  for (const entry of entries ?? []) {
    if (entry.selectionPolicy) {
      policies.set(entry.provider, entry.selectionPolicy);
    }
  }
  return policies;
}

export function startsNewSessionsFromDefaults(
  policy: AgentProviderSelectionPolicy | null | undefined,
): boolean {
  return policy?.preferenceMode === "defaults";
}
