import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";

/** The agent session in the viewed tab, whose task list the right panel shows (delta 101). */
export function resolveViewedAgentId(descriptor: WorkspaceTabDescriptor | null): string | null {
  return descriptor?.target.kind === "agent" ? descriptor.target.agentId : null;
}

/**
 * The viewed agent session of a workspace, read from its layout the way the workspace screen reads
 * it: the focused pane's active tab. The compact right panel is mounted at app level, outside the
 * workspace screen, so it resolves the same tab from the layout store.
 */
export function resolveWorkspaceViewedAgentId(layout: WorkspaceLayout | null): string | null {
  if (!layout) {
    return null;
  }
  const paneState = deriveWorkspacePaneState({ layout, tabs: collectAllTabs(layout.root) });
  return resolveViewedAgentId(paneState.activeTab?.descriptor ?? null);
}
