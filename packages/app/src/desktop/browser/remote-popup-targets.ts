import { create } from "zustand";
import type { BrowserRemoteTabInfo } from "@getpaseo/protocol/messages";

export type RemoteBrowserPopupTarget = BrowserRemoteTabInfo & {
  kind: "popup";
  rootBrowserId: string;
  openerBrowserId: string;
};

interface RemoteBrowserPopupTargetsState {
  targetsByScope: Record<string, RemoteBrowserPopupTarget[]>;
  replaceWorkspaceTargets: (input: {
    serverId: string;
    workspaceId: string;
    tabs: readonly BrowserRemoteTabInfo[];
  }) => void;
}

const EMPTY_POPUP_TARGETS: RemoteBrowserPopupTarget[] = [];

function workspacePrefix(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}:`;
}

function popupScopeKey(serverId: string, workspaceId: string, rootBrowserId: string): string {
  return `${workspacePrefix(serverId, workspaceId)}${rootBrowserId}`;
}

function readPopupTarget(tab: BrowserRemoteTabInfo): RemoteBrowserPopupTarget | null {
  if (
    tab.kind !== "popup" ||
    !tab.rootBrowserId ||
    !tab.openerBrowserId ||
    tab.browserId === tab.rootBrowserId
  ) {
    return null;
  }
  return {
    ...tab,
    kind: "popup",
    rootBrowserId: tab.rootBrowserId,
    openerBrowserId: tab.openerBrowserId,
  };
}

export const useRemoteBrowserPopupTargetsStore = create<RemoteBrowserPopupTargetsState>((set) => ({
  targetsByScope: {},
  replaceWorkspaceTargets: ({ serverId, workspaceId, tabs }) => {
    const grouped = new Map<string, RemoteBrowserPopupTarget[]>();
    for (const tab of tabs) {
      const popup = readPopupTarget(tab);
      if (!popup || (popup.workspaceId && popup.workspaceId !== workspaceId)) {
        continue;
      }
      const key = popupScopeKey(serverId, workspaceId, popup.rootBrowserId);
      const targets = grouped.get(key) ?? [];
      targets.push(popup);
      grouped.set(key, targets);
    }
    set((state) => {
      const prefix = workspacePrefix(serverId, workspaceId);
      const next = Object.fromEntries(
        Object.entries(state.targetsByScope).filter(([key]) => !key.startsWith(prefix)),
      );
      for (const [key, targets] of grouped) {
        next[key] = targets;
      }
      return { targetsByScope: next };
    });
  },
}));

export function replaceRemoteBrowserPopupTargets(input: {
  serverId: string;
  workspaceId: string;
  tabs: readonly BrowserRemoteTabInfo[];
}): void {
  useRemoteBrowserPopupTargetsStore.getState().replaceWorkspaceTargets(input);
}

export function getRemoteBrowserPopupTargets(input: {
  serverId: string;
  workspaceId: string;
  rootBrowserId: string;
}): RemoteBrowserPopupTarget[] {
  return (
    useRemoteBrowserPopupTargetsStore.getState().targetsByScope[
      popupScopeKey(input.serverId, input.workspaceId, input.rootBrowserId)
    ] ?? EMPTY_POPUP_TARGETS
  );
}

export function useRemoteBrowserPopupTargets(input: {
  serverId: string;
  workspaceId: string;
  rootBrowserId: string;
}): RemoteBrowserPopupTarget[] {
  const key = popupScopeKey(input.serverId, input.workspaceId, input.rootBrowserId);
  return useRemoteBrowserPopupTargetsStore(
    (state) => state.targetsByScope[key] ?? EMPTY_POPUP_TARGETS,
  );
}
