import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";

// Daseo delta 70: when a workspace counts as never used, and which empty tabs close on leaving.

/** Tab kinds that mean something happened in the workspace; files and diffs are only views. */
const WORK_TAB_KINDS = new Set<WorkspaceTabTarget["kind"]>([
  "agent",
  "provider_subagent",
  "terminal",
  "browser",
]);

export interface EmptyWorkspaceFacts {
  workspaceKind: string;
  pinned: boolean;
  hasAgents: boolean;
  tabs: readonly WorkspaceTab[];
  /** True when the draft behind a draft tab holds text, attachments, or a send in flight. */
  isDraftUsed: (draftId: string) => boolean;
}

export function isWorkspaceUnused(facts: EmptyWorkspaceFacts): boolean {
  if (facts.workspaceKind === "local_checkout" || facts.workspaceKind === "checkout") {
    return false;
  }
  if (facts.pinned || facts.hasAgents) {
    return false;
  }
  return facts.tabs.every((tab) => {
    if (WORK_TAB_KINDS.has(tab.target.kind)) {
      return false;
    }
    return tab.target.kind !== "draft" || !facts.isDraftUsed(tab.target.draftId);
  });
}

/** Draft tabs to close when leaving a workspace that stays: empty, and not the only tab left. */
export function findEmptyDraftTabs(
  tabs: readonly WorkspaceTab[],
  isDraftUsed: (draftId: string) => boolean,
): WorkspaceTab[] {
  const empty = tabs.filter(
    (tab) => tab.target.kind === "draft" && !isDraftUsed(tab.target.draftId),
  );
  return empty.length === tabs.length ? [] : empty;
}
