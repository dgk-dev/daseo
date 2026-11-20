import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { agentCommandsQueryKey, type AgentCommandsDraftConfig } from "@/hooks/agent-commands-query";

// Daseo delta 138: the daemon caches command lists per provider and cwd, so a refetch is cheap;
// a draft picks up a new skill within 5 minutes, and a list survives 30 minutes away from a tab.
const DRAFT_COMMANDS_STALE_TIME = 5 * 60_000;
const SESSION_COMMANDS_STALE_TIME = 60_000;
const AGENT_COMMANDS_GC_TIME = 30 * 60_000;

export function agentCommandsQueryTiming(isDraft: boolean): { staleTime: number; gcTime: number } {
  return {
    staleTime: isDraft ? DRAFT_COMMANDS_STALE_TIME : SESSION_COMMANDS_STALE_TIME,
    gcTime: AGENT_COMMANDS_GC_TIME,
  };
}

/**
 * Commands load while "/" autocomplete is open and, ahead of it, while the composer has focus,
 * so the first "/" reads a warm list. The daemon answers an unloaded agent without loading it.
 */
export function shouldLoadAgentCommands(input: {
  commandAutocompleteOpen: boolean;
  composerFocused: boolean;
  canLoadCommands: boolean;
}): boolean {
  return input.canLoadCommands && (input.commandAutocompleteOpen || input.composerFocused);
}

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

export type DraftCommandConfig = AgentCommandsDraftConfig;

interface ListAgentCommandsOptions {
  agentId: string;
  draftConfig?: DraftCommandConfig;
}

export interface AgentCommandsClient {
  listCommands(options: ListAgentCommandsOptions): ReturnType<DaemonClient["listCommands"]>;
}

export async function fetchAgentCommands(input: {
  client: AgentCommandsClient;
  agentId: string;
  draftConfig?: DraftCommandConfig;
}): Promise<AgentSlashCommand[]> {
  const response = await input.client.listCommands({
    agentId: input.agentId,
    draftConfig: input.draftConfig,
  });
  return response.commands as AgentSlashCommand[];
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  draftConfig?: DraftCommandConfig;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
  draftConfig,
}: UseAgentCommandsQueryOptions) {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: agentCommandsQueryKey({ serverId, agentId, draftConfig }),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchAgentCommands({ client, agentId, draftConfig });
    },
    enabled: queryEnabled && !!client && isConnected && (!!agentId || !!draftConfig),
    ...agentCommandsQueryTiming(!!draftConfig),
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;

  return {
    commands: query.data ?? [],
    isLoading,
    isError: query.isError,
    error: query.error,
  };
}
