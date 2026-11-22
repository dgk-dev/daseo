import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useFetchQuery } from "@/data/query";
import { hostSupportsFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  fetchSlackScheduled,
  SLACK_SCHEDULED_REFRESH_MS,
  slackScheduledQueryBaseKey,
  type AggregatedSlackScheduled,
  type SlackScheduledActionResult,
  type SlackScheduledChange,
  type SlackScheduledFetchResult,
  type SlackScheduledHostInput,
} from "@/schedules/slack-scheduled";
import { toErrorMessage } from "@/utils/error-messages";

export interface UseSlackScheduledResult {
  /** At least one host advertises `slackScheduledList`; without one the filter is not offered. */
  supported: boolean;
  data: SlackScheduledFetchResult | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  /** The owner's buttons (2026-11-23): only on entries whose host advertises slackScheduledActions. */
  actions: SlackScheduledActions;
}

export interface SlackScheduledActions {
  canChange(serverId: string): boolean;
  cancel(entry: AggregatedSlackScheduled): Promise<SlackScheduledActionResult>;
  update(
    entry: AggregatedSlackScheduled,
    change: SlackScheduledChange,
  ): Promise<SlackScheduledActionResult>;
}

const HOST_OFFLINE = "This host is not connected";

/**
 * Daseo delta 135: scheduled Slack messages from every host that lists them. Fetches only while
 * `active` (the Slack filter is open) and then every 60 seconds; the daemon caches for the same
 * time, so a refresh costs at most one Slack check per minute.
 */
export function useSlackScheduled(active: boolean): UseSlackScheduledResult {
  const hosts = useHosts();
  const supportingServerIds = useSessionStore(
    useShallow((state) =>
      hosts
        .map((host) => host.serverId)
        .filter((serverId) =>
          hostSupportsFeature(state.sessions[serverId]?.serverInfo, "slackScheduledList"),
        ),
    ),
  );
  const hostInputs = useMemo<SlackScheduledHostInput[]>(
    () =>
      hosts
        .filter((host) => supportingServerIds.includes(host.serverId))
        .map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts, supportingServerIds],
  );
  const actionServerIds = useSessionStore(
    useShallow((state) =>
      hosts
        .map((host) => host.serverId)
        .filter((serverId) =>
          hostSupportsFeature(state.sessions[serverId]?.serverInfo, "slackScheduledActions"),
        ),
    ),
  );
  const connectionStatuses = useHostRuntimeConnectionStatuses(supportingServerIds);
  const connectionKey = supportingServerIds
    .map((serverId) => `${serverId}=${connectionStatuses.get(serverId) ?? "connecting"}`)
    .join("|");
  const supported = hostInputs.length > 0;
  const enabled = active && supported;

  const query = useFetchQuery({
    queryKey: [...slackScheduledQueryBaseKey, connectionKey],
    queryFn: () => {
      const runtime = getHostRuntimeStore();
      return fetchSlackScheduled({
        hosts: hostInputs,
        runtime: {
          getClient: (serverId) => runtime.getClient(serverId),
          isOnline: (serverId) => runtime.getSnapshot(serverId)?.connectionStatus === "online",
        },
      });
    },
    enabled,
    dataShape: "list",
    // Opening the filter always asks again; the daemon answers from its own 60 s cache.
    staleTimeMs: 0,
    refetchInterval: enabled ? SLACK_SCHEDULED_REFRESH_MS : false,
  });

  const { refetch } = query;
  // The daemon drops its cached list after every action, so a refetch shows what happened.
  const runAction = useCallback(
    async (
      serverId: string,
      action: (
        client: Pick<DaemonClient, "cancelSlackScheduled" | "updateSlackScheduled">,
      ) => Promise<{ ok: boolean; error: string | null; newId?: string | null }>,
    ): Promise<SlackScheduledActionResult> => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) return { ok: false, error: HOST_OFFLINE };
      let result: SlackScheduledActionResult;
      try {
        const payload = await action(client);
        result = payload.ok
          ? { ok: true, newId: payload.newId ?? null }
          : { ok: false, error: payload.error ?? "The change failed" };
      } catch (error) {
        result = { ok: false, error: toErrorMessage(error) };
      }
      void refetch();
      return result;
    },
    [refetch],
  );
  const actions = useMemo<SlackScheduledActions>(
    () => ({
      canChange: (serverId) => actionServerIds.includes(serverId),
      cancel: (entry) =>
        runAction(entry.serverId, (client) => client.cancelSlackScheduled(entry.id)),
      update: (entry, change) =>
        runAction(entry.serverId, (client) =>
          client.updateSlackScheduled({ id: entry.id, ...change }),
        ),
    }),
    [actionServerIds, runAction],
  );

  return {
    supported,
    data: query.data,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch: () => {
      void refetch();
    },
    actions,
  };
}
