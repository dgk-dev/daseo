import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useStoreReady } from "@/app/_layout";
import { useAppSettings } from "@/hooks/use-settings";
import {
  QUICK_ASK_HOME_DIRECTORY,
  resolveQuickAskProject,
  resolveQuickAskServerId,
} from "@/navigation/quick-ask";
import type { AgentRouteResolution } from "@/navigation/agent-route-resolution";
import { AgentRouteResolutionView } from "@/navigation/agent-route-resolution-view";
import {
  getHostRuntimeStore,
  useHostRegistryStatus,
  useHostRuntimeSnapshot,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { generateDraftId } from "@/stores/draft-keys";
import {
  navigateToWorkspace,
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useQuickAskStore } from "@/stores/quick-ask-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildSettingsHostRoute } from "@/utils/host-routes";

type QuickAskOpenState =
  | { kind: "waiting" }
  | { kind: "opening" }
  | { kind: "failed"; error: string };

type QuickAskStatusResolution = Extract<
  AgentRouteResolution,
  { kind: "waitingForHost" | "fetchingAgent" | "lookupError" }
>;

interface QuickAskTarget {
  serverId: string | null;
  hostName: string;
  client: DaemonClient | null;
  connectionStatus: HostRuntimeConnectionStatus;
  lastHostError: string | null;
  isReady: boolean;
  noHosts: boolean;
  quickAskProjects: Record<string, string>;
}

/** The host quick ask goes to, and whether its workspaces are known well enough to choose. */
function useQuickAskTarget(): QuickAskTarget {
  const storeReady = useStoreReady();
  const hostRegistryStatus = useHostRegistryStatus();
  const hosts = useHosts();
  const lastSelection = useLastWorkspaceSelection();
  const isSelectionHydrated = useIsLastWorkspaceSelectionHydrated();
  const { settings, isLoading: settingsLoading } = useAppSettings();
  const inputsReady = hostRegistryStatus === "ready" && isSelectionHydrated && !settingsLoading;
  const serverId = inputsReady
    ? resolveQuickAskServerId({
        hosts,
        lastSelectionServerId: lastSelection?.serverId ?? null,
        quickAskProjects: settings.quickAskProjects,
      })
    : null;
  const snapshot = useHostRuntimeSnapshot(serverId ?? "");
  const workspacesHydrated = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const client = snapshot?.client ?? null;
  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  return {
    serverId,
    hostName: hosts.find((host) => host.serverId === serverId)?.label ?? serverId ?? "",
    client,
    connectionStatus,
    lastHostError: snapshot?.lastError ?? null,
    isReady: storeReady && client !== null && connectionStatus === "online" && workspacesHydrated,
    noHosts: hostRegistryStatus === "ready" && hosts.length === 0,
    quickAskProjects: settings.quickAskProjects,
  };
}

async function openQuickAskDraft(input: {
  serverId: string;
  client: DaemonClient;
  configuredProjectId: string | null;
}): Promise<void> {
  const session = useSessionStore.getState().sessions[input.serverId];
  const target = resolveQuickAskProject({
    configuredProjectId: input.configuredProjectId,
    projects: session?.projects.values() ?? [],
  });
  // A new workspace every time, like the sidebar's "new workspace" row: no title, so the daemon
  // names it from the first prompt.
  const payload = await input.client.createWorkspace({
    source:
      target.kind === "project"
        ? { kind: "directory", path: target.directory, projectId: target.projectId }
        : { kind: "directory", path: QUICK_ASK_HOME_DIRECTORY },
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "Workspace was not created");
  }
  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  useSessionStore.getState().mergeWorkspaces(input.serverId, [workspace]);
  const draftId = generateDraftId();
  useQuickAskStore
    .getState()
    .request({ serverId: input.serverId, workspaceId: workspace.id, draftId });
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: workspace.id,
    target: { kind: "draft", draftId },
  });
}

/** Opens the quick-ask draft once the target is ready; a failure can be retried. */
function useQuickAskOpener(target: QuickAskTarget): {
  openState: QuickAskOpenState;
  retryOpen: () => void;
} {
  const [openState, setOpenState] = useState<QuickAskOpenState>({ kind: "waiting" });
  const startedRef = useRef(false);
  const { isReady, serverId, client, quickAskProjects } = target;

  useEffect(() => {
    if (!isReady || !serverId || !client || startedRef.current || openState.kind !== "waiting") {
      return;
    }
    startedRef.current = true;
    setOpenState({ kind: "opening" });
    openQuickAskDraft({
      serverId,
      client,
      configuredProjectId: quickAskProjects[serverId] ?? null,
    }).catch((error: unknown) => {
      startedRef.current = false;
      setOpenState({ kind: "failed", error: toErrorMessage(error) });
    });
  }, [client, isReady, openState.kind, quickAskProjects, serverId]);

  const retryOpen = useCallback(() => setOpenState({ kind: "waiting" }), []);
  return { openState, retryOpen };
}

function resolveStatus(
  openState: QuickAskOpenState,
  serverId: string | null,
  connectionStatus: HostRuntimeConnectionStatus,
): QuickAskStatusResolution {
  if (openState.kind === "failed") {
    return { kind: "lookupError", error: openState.error };
  }
  if (serverId && connectionStatus !== "online") {
    return { kind: "waitingForHost", connectionStatus };
  }
  return { kind: "fetchingAgent" };
}

/**
 * Daseo delta 64: `paseo://quick-ask` lands here, possibly on a cold start before any host is
 * connected. The screen waits for the chosen host like the agent route does, picks the quick-ask
 * project, creates a new workspace in it and opens a new draft tab there marked for quick ask
 * (a new workspace and a new agent every time).
 */
export function QuickAskScreen() {
  const router = useRouter();
  const target = useQuickAskTarget();
  const { openState, retryOpen } = useQuickAskOpener(target);
  const { serverId, noHosts, connectionStatus } = target;
  const resolution = useMemo(
    () => resolveStatus(openState, serverId, connectionStatus),
    [connectionStatus, openState, serverId],
  );

  useEffect(() => {
    if (noHosts) {
      router.replace("/" as Href);
    }
  }, [noHosts, router]);

  const handleRetry = useCallback(() => {
    if (openState.kind === "failed") {
      retryOpen();
      return;
    }
    if (serverId) {
      void getHostRuntimeStore().runProbeCycleNow(serverId);
    }
  }, [openState.kind, retryOpen, serverId]);
  const handleManageHost = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostRoute(serverId));
    }
  }, [router, serverId]);
  const handleBack = useCallback(() => {
    router.replace("/" as Href);
  }, [router]);

  return (
    <AgentRouteResolutionView
      resolution={resolution}
      hostName={target.hostName}
      lastHostError={resolution.kind === "waitingForHost" ? target.lastHostError : null}
      onRetry={handleRetry}
      onManageHost={handleManageHost}
      onBack={handleBack}
    />
  );
}
