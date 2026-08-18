import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
import { adoptWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import {
  collectAllTabs,
  findPaneById,
  getFocusedBrowserId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { reconcileRemoteBrowserTabs, type RemoteBrowserTabInfo } from "./remote-tabs-sync";
import {
  getRemoteBrowserPopupTargets,
  useRemoteBrowserPopupTargetsStore,
} from "./remote-popup-targets";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const WORKSPACE_KEY = buildWorkspaceTabPersistenceKey({
  serverId: SERVER_ID,
  workspaceId: WORKSPACE_ID,
})!;
const OTHER_WORKSPACE_KEY = buildWorkspaceTabPersistenceKey({
  serverId: SERVER_ID,
  workspaceId: "workspace-2",
})!;
const BROWSER_ONE = "11111111-1111-4111-8111-111111111111";
const BROWSER_TWO = "22222222-2222-4222-8222-222222222222";
const BROWSER_STALE = "33333333-3333-4333-8333-333333333333";

function remote(
  browserId: string,
  patch: Partial<RemoteBrowserTabInfo> = {},
): RemoteBrowserTabInfo {
  return {
    browserId,
    workspaceId: WORKSPACE_ID,
    url: "https://example.com",
    title: "Example",
    isActive: false,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    ...patch,
  };
}

function browserIdsInLayout(): string[] {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) return [];
  return collectAllTabs(layout.root).flatMap((tab) =>
    tab.target.kind === "browser" ? [tab.target.browserId] : [],
  );
}

describe("reconcileRemoteBrowserTabs", () => {
  beforeEach(() => {
    useWorkspaceLayoutStore.getState().purgeWorkspace(WORKSPACE_KEY);
    useWorkspaceLayoutStore.getState().purgeWorkspace(OTHER_WORKSPACE_KEY);
    useBrowserStore.setState({ browsersById: {} });
    useRemoteBrowserPopupTargetsStore.setState({ targetsByScope: {} });
  });

  test("discovers host tabs and removes a stale persisted mobile viewer", () => {
    adoptWorkspaceBrowser(BROWSER_STALE);
    useWorkspaceLayoutStore.getState().openTabInBackground(WORKSPACE_KEY, {
      kind: "browser",
      browserId: BROWSER_STALE,
    });

    const result = reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE), remote(BROWSER_TWO, { title: "Second" })],
    });

    expect(result).toEqual({ added: 2, removed: 1, updated: 2 });
    expect(new Set(browserIdsInLayout())).toEqual(new Set([BROWSER_ONE, BROWSER_TWO]));
    expect(useBrowserStore.getState().browsersById[BROWSER_STALE]).toBeUndefined();
    expect(useBrowserStore.getState().browsersById[BROWSER_TWO]?.title).toBe("Second");
  });

  test("refreshes URL and navigation state without duplicating existing tabs", () => {
    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE)],
    });

    const result = reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [
        remote(BROWSER_ONE, {
          url: "https://example.com/next",
          title: "Next",
          isLoading: true,
          canGoBack: true,
        }),
      ],
    });

    expect(result).toEqual({ added: 0, removed: 0, updated: 1 });
    expect(browserIdsInLayout()).toEqual([BROWSER_ONE]);
    expect(useBrowserStore.getState().browsersById[BROWSER_ONE]).toMatchObject({
      url: "https://example.com/next",
      title: "Next",
      isLoading: true,
      canGoBack: true,
    });
  });

  test("seeds the authoritative desktop browser only when mobile has no selection", () => {
    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE, { isActive: true }), remote(BROWSER_TWO)],
    });
    expect(
      getFocusedBrowserId(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]),
    ).toBe(BROWSER_ONE);

    useWorkspaceLayoutStore.getState().focusTab(WORKSPACE_KEY, `browser_${BROWSER_TWO}`);
    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE, { isActive: true }), remote(BROWSER_TWO)],
    });
    expect(
      getFocusedBrowserId(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]),
    ).toBe(BROWSER_TWO);
  });

  test("keeps a user-selected agent open while desktop browser state refreshes", () => {
    const agentTabId = useWorkspaceLayoutStore.getState().openTabFocused(WORKSPACE_KEY, {
      kind: "agent",
      agentId: "agent-1",
    });

    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE, { isActive: true })],
    });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(agentTabId);
  });

  test("places discovered browser tabs directly after the current tab in host order", () => {
    const layoutStore = useWorkspaceLayoutStore.getState();
    const agentTabId = layoutStore.openTabFocused(WORKSPACE_KEY, {
      kind: "agent",
      agentId: "agent-1",
    });
    const tailTabId = layoutStore.openTabFocused(WORKSPACE_KEY, {
      kind: "draft",
      draftId: "draft-tail",
    });
    layoutStore.focusTab(WORKSPACE_KEY, agentTabId!);

    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE), remote(BROWSER_TWO)],
    });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.tabIds).toEqual([
      agentTabId,
      `browser_${BROWSER_ONE}`,
      `browser_${BROWSER_TWO}`,
      tailTabId,
    ]);
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(agentTabId);
  });

  test("deduplicates replayed host entries and keeps the newest state", () => {
    const result = reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE, { title: "Old" }), remote(BROWSER_ONE, { title: "Newest" })],
    });

    expect(result.added).toBe(1);
    expect(browserIdsInLayout()).toEqual([BROWSER_ONE]);
    expect(useBrowserStore.getState().browsersById[BROWSER_ONE]?.title).toBe("Newest");
  });

  test("does not disturb browser tabs belonging to another workspace", () => {
    adoptWorkspaceBrowser(BROWSER_TWO);
    useWorkspaceLayoutStore.getState().openTabInBackground(OTHER_WORKSPACE_KEY, {
      kind: "browser",
      browserId: BROWSER_TWO,
    });

    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [],
    });

    const otherLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[OTHER_WORKSPACE_KEY];
    expect(otherLayout && collectAllTabs(otherLayout.root)).toHaveLength(1);
    expect(useBrowserStore.getState().browsersById[BROWSER_TWO]).toBeDefined();
  });

  test("keeps popup targets nested under their root browser on mobile", () => {
    const popupId = BROWSER_TWO;
    const result = reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [
        remote(BROWSER_ONE),
        remote(popupId, {
          kind: "popup",
          rootBrowserId: BROWSER_ONE,
          openerBrowserId: BROWSER_ONE,
          title: "Sign in",
          isActive: true,
        }),
      ],
    });

    expect(result).toEqual({ added: 1, removed: 0, updated: 1 });
    expect(browserIdsInLayout()).toEqual([BROWSER_ONE]);
    expect(useBrowserStore.getState().browsersById[popupId]).toBeUndefined();
    expect(
      getRemoteBrowserPopupTargets({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        rootBrowserId: BROWSER_ONE,
      }),
    ).toEqual([
      expect.objectContaining({
        browserId: popupId,
        rootBrowserId: BROWSER_ONE,
        openerBrowserId: BROWSER_ONE,
        isActive: true,
      }),
    ]);
    expect(
      getFocusedBrowserId(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]),
    ).toBe(BROWSER_ONE);

    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE, { isActive: true })],
    });
    expect(
      getRemoteBrowserPopupTargets({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        rootBrowserId: BROWSER_ONE,
      }),
    ).toEqual([]);
    expect(browserIdsInLayout()).toEqual([BROWSER_ONE]);
  });

  test("an authoritative empty host list clears mobile browser tabs only", () => {
    useWorkspaceLayoutStore.getState().openTabInBackground(WORKSPACE_KEY, {
      kind: "draft",
      draftId: "draft-keep",
    });
    reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [remote(BROWSER_ONE), remote(BROWSER_TWO)],
    });

    const result = reconcileRemoteBrowserTabs({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      tabs: [],
    });

    expect(result.removed).toBe(2);
    expect(browserIdsInLayout()).toEqual([]);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(layout && collectAllTabs(layout.root).some((tab) => tab.target.kind === "draft")).toBe(
      true,
    );
  });
});
