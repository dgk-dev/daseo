import { useEffect, useRef } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import {
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { findEmptyDraftTabs, isWorkspaceUnused } from "./discard-empty-rules";

// Daseo delta 70: a workspace the owner opened and left without a single message is deleted, not
// archived, so it never shows up in the sidebar or the archive. Inside a workspace that stays,
// empty new-agent tabs close when the owner leaves. The daemon re-checks emptiness itself
// (agents, terminals, worktree changes, checkout, pin, manual title) before deleting anything.

function isDraftUsed(serverId: string, draftId: string): boolean {
  const draft = useDraftStore
    .getState()
    .getDraftInput(buildDraftStoreKey({ serverId, agentId: "", draftId }));
  if (draft && (draft.text.trim().length > 0 || draft.attachments.length > 0)) {
    return true;
  }
  const pending = useCreateFlowStore.getState().pendingByDraftId[draftId];
  return pending !== undefined && pending.lifecycle !== "abandoned";
}

async function cleanUpLeftWorkspace(selection: ActiveWorkspaceSelection): Promise<void> {
  const { serverId, workspaceId } = selection;
  const session = useSessionStore.getState().sessions[serverId];
  const workspace = session?.workspaces.get(workspaceId);
  if (!session || !workspace) {
    return;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) {
    return;
  }
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const tabs = layout ? collectAllTabs(layout.root) : [];
  const draftUsed = (draftId: string) => isDraftUsed(serverId, draftId);
  const hasAgents = Array.from(session.agents.values()).some(
    (agent) => agent.workspaceId === workspaceId,
  );
  const unused = isWorkspaceUnused({
    workspaceKind: workspace.workspaceKind,
    pinned: Boolean(workspace.pinnedAt),
    hasAgents,
    tabs,
    isDraftUsed: draftUsed,
  });

  const client = getHostRuntimeStore().getClient(serverId);
  if (unused && client && session.serverInfo?.features?.discardEmptyWorkspace === true) {
    try {
      const result = await client.discardEmptyWorkspace(workspaceId);
      if (result.discarded) {
        console.info("[workspace] discarded an empty workspace", { workspaceId });
        return;
      }
      console.info("[workspace] kept a workspace without messages", {
        workspaceId,
        reason: result.reason,
      });
    } catch (error) {
      console.warn("[workspace] could not discard an empty workspace", error);
    }
  }

  const layoutStore = useWorkspaceLayoutStore.getState();
  for (const tab of findEmptyDraftTabs(tabs, draftUsed)) {
    layoutStore.closeTab(workspaceKey, tab.tabId);
  }
}

/** Mounted once at the root: cleans up the workspace the owner just switched away from. */
export function DiscardEmptyWorkspacesOnLeave() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  // Screens outside any workspace (settings, the quick-ask route) are not "leaving": the last
  // workspace is compared with the next workspace the owner opens.
  const previousRef = useRef<ActiveWorkspaceSelection | null>(null);
  useEffect(() => {
    if (!serverId || !workspaceId) {
      return;
    }
    const previous = previousRef.current;
    previousRef.current = { serverId, workspaceId };
    if (!previous || (previous.serverId === serverId && previous.workspaceId === workspaceId)) {
      return;
    }
    void cleanUpLeftWorkspace(previous);
  }, [serverId, workspaceId]);
  return null;
}
