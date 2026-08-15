import {
  adoptWorkspaceBrowser,
  useBrowserStore,
  type BrowserRecord,
} from "@/desktop/browser/store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface RemoteBrowserTabInfo {
  browserId: string;
  workspaceId?: string;
  url: string;
  title: string;
  isActive: boolean;
  isLoading: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface RemoteBrowserSyncResult {
  added: number;
  removed: number;
  updated: number;
}

function browserStateChanged(existing: BrowserRecord, remote: RemoteBrowserTabInfo): boolean {
  return (
    existing.url !== remote.url ||
    existing.title !== remote.title ||
    existing.isLoading !== remote.isLoading ||
    existing.canGoBack !== (remote.canGoBack ?? false) ||
    existing.canGoForward !== (remote.canGoForward ?? false) ||
    existing.lastError !== null
  );
}

/**
 * Reconcile a mobile workspace's persisted browser tabs against the desktop
 * host, which is authoritative for browser lifetime and state.
 */
export function reconcileRemoteBrowserTabs(input: {
  serverId: string;
  workspaceId: string;
  tabs: readonly RemoteBrowserTabInfo[];
}): RemoteBrowserSyncResult {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) return { added: 0, removed: 0, updated: 0 };

  // Broker output is expected to be unique, but normalize defensively so a
  // reconnect/replayed host response cannot create duplicate mobile viewers.
  const remoteTabs = [...new Map(input.tabs.map((tab) => [tab.browserId, tab])).values()];
  const layoutStore = useWorkspaceLayoutStore.getState();
  const browserStore = useBrowserStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  const localTabs = layout
    ? collectAllTabs(layout.root).filter((tab) => tab.target.kind === "browser")
    : [];
  const localByBrowserId = new Map<string, typeof localTabs>();
  for (const tab of localTabs) {
    const browserId = tab.target.kind === "browser" ? tab.target.browserId : "";
    const grouped = localByBrowserId.get(browserId) ?? [];
    grouped.push(tab);
    localByBrowserId.set(browserId, grouped);
  }

  const remoteIds = new Set(remoteTabs.map((tab) => tab.browserId));
  let added = 0;
  let removed = 0;
  let updated = 0;

  for (const remote of remoteTabs) {
    let existing = browserStore.browsersById[remote.browserId];
    if (!existing) {
      adoptWorkspaceBrowser(remote.browserId, { initialUrl: remote.url });
      existing = useBrowserStore.getState().browsersById[remote.browserId];
    }
    const canGoBack = remote.canGoBack ?? false;
    const canGoForward = remote.canGoForward ?? false;
    if (existing && browserStateChanged(existing, remote)) {
      useBrowserStore.getState().updateBrowser(remote.browserId, {
        url: remote.url,
        title: remote.title,
        isLoading: remote.isLoading,
        canGoBack,
        canGoForward,
        lastError: null,
      });
      updated += 1;
    }

    const matching = localByBrowserId.get(remote.browserId) ?? [];
    if (matching.length === 0) {
      layoutStore.openTabInBackground(workspaceKey, {
        kind: "browser",
        browserId: remote.browserId,
      });
      added += 1;
      continue;
    }
    // Collapse any historical duplicate viewers for the same authoritative tab.
    for (const duplicate of matching.slice(1)) {
      layoutStore.closeTab(workspaceKey, duplicate.tabId);
      removed += 1;
    }
  }

  for (const [browserId, workspaceTabs] of localByBrowserId) {
    if (remoteIds.has(browserId)) continue;
    for (const tab of workspaceTabs) {
      layoutStore.closeTab(workspaceKey, tab.tabId);
      removed += 1;
    }
    useBrowserStore.getState().removeBrowser(browserId);
  }

  return { added, removed, updated };
}
