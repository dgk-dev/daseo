import {
  adoptWorkspaceBrowser,
  useBrowserStore,
  type BrowserRecord,
} from "@/desktop/browser/store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";
import { replaceRemoteBrowserPopupTargets } from "@/desktop/browser/remote-popup-targets";

export interface RemoteBrowserTabInfo {
  browserId: string;
  workspaceId?: string;
  kind?: "tab" | "popup";
  rootBrowserId?: string;
  openerBrowserId?: string;
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

function groupLocalBrowserTabs(layout: WorkspaceLayout | undefined) {
  const localTabs = layout
    ? collectAllTabs(layout.root).filter(
        (tab): tab is WorkspaceTab & { target: { kind: "browser"; browserId: string } } =>
          tab.target.kind === "browser",
      )
    : [];
  const localByBrowserId = new Map<string, typeof localTabs>();
  for (const tab of localTabs) {
    const grouped = localByBrowserId.get(tab.target.browserId) ?? [];
    grouped.push(tab);
    localByBrowserId.set(tab.target.browserId, grouped);
  }
  return localByBrowserId;
}

function placeAddedTabsAfterInitialFocus(input: {
  workspaceKey: string;
  initialPaneId: string | null;
  initialFocusedTabId: string | null;
  addedTabIds: readonly string[];
}): void {
  if (!input.initialPaneId || !input.initialFocusedTabId || input.addedTabIds.length === 0) {
    return;
  }

  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[input.workspaceKey];
  const pane = layout ? findPaneById(layout.root, input.initialPaneId) : null;
  if (!pane) return;

  const addedSet = new Set(input.addedTabIds);
  const orderedAddedTabIds = input.addedTabIds.filter((tabId) => pane.tabIds.includes(tabId));
  const retainedTabIds = pane.tabIds.filter((tabId) => !addedSet.has(tabId));
  const anchorIndex = retainedTabIds.indexOf(input.initialFocusedTabId);
  if (anchorIndex < 0 || orderedAddedTabIds.length === 0) return;

  layoutStore.reorderTabsInPane(input.workspaceKey, input.initialPaneId, [
    ...retainedTabIds.slice(0, anchorIndex + 1),
    ...orderedAddedTabIds,
    ...retainedTabIds.slice(anchorIndex + 1),
  ]);
}

function seedInitialAuthoritativeBrowser(input: {
  workspaceKey: string;
  shouldSeedFocus: boolean;
  remoteTabs: readonly RemoteBrowserTabInfo[];
  localTabIdByBrowserId: ReadonlyMap<string, string>;
}): void {
  if (!input.shouldSeedFocus) return;
  const activeBrowserId = input.remoteTabs.find((tab) => tab.isActive)?.browserId;
  if (!activeBrowserId) return;
  const activeTabId = input.localTabIdByBrowserId.get(activeBrowserId);
  if (activeTabId) {
    useWorkspaceLayoutStore.getState().focusTab(input.workspaceKey, activeTabId);
  }
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

  replaceRemoteBrowserPopupTargets({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    tabs: input.tabs,
  });

  // Broker output is expected to be unique, but normalize defensively so a
  // reconnect/replayed host response cannot create duplicate mobile viewers. Popup
  // targets remain nested under their root browser instead of becoming workspace tabs.
  const activePopupRootIds = new Set(
    input.tabs.flatMap((tab) =>
      tab.kind === "popup" && tab.rootBrowserId && tab.isActive ? [tab.rootBrowserId] : [],
    ),
  );
  const remoteTabs = [
    ...new Map(
      input.tabs
        .filter((tab) => tab.kind !== "popup")
        .map((tab) => [
          tab.browserId,
          {
            ...tab,
            isActive: tab.isActive || activePopupRootIds.has(tab.browserId),
          },
        ]),
    ).values(),
  ];
  const layoutStore = useWorkspaceLayoutStore.getState();
  const browserStore = useBrowserStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  const initialFocusedPane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  const initialFocusedTabId = initialFocusedPane?.focusedTabId ?? null;
  const localByBrowserId = groupLocalBrowserTabs(layout);

  const remoteIds = new Set(remoteTabs.map((tab) => tab.browserId));
  const localTabIdByBrowserId = new Map<string, string>();
  const addedTabIds: string[] = [];
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
      const tabId = layoutStore.openTabInBackground(workspaceKey, {
        kind: "browser",
        browserId: remote.browserId,
      });
      if (tabId) {
        localTabIdByBrowserId.set(remote.browserId, tabId);
        addedTabIds.push(tabId);
      }
      added += 1;
      continue;
    }
    localTabIdByBrowserId.set(remote.browserId, matching[0]!.tabId);
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

  placeAddedTabsAfterInitialFocus({
    workspaceKey,
    initialPaneId: initialFocusedPane?.id ?? null,
    initialFocusedTabId,
    addedTabIds,
  });
  seedInitialAuthoritativeBrowser({
    workspaceKey,
    shouldSeedFocus: initialFocusedTabId === null,
    remoteTabs,
    localTabIdByBrowserId,
  });

  return { added, removed, updated };
}
