import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useBrowserProvenanceStore } from "./index";

/**
 * Daseo delta 98: reopens a tab the auto-close closed, in the workspace's focused pane, at the
 * URL it had. The reopened tab is a person's (it is never closed automatically) and leaves the
 * recently closed list. False when the entry is already gone.
 */
export function reopenRecentlyClosedBrowser(input: {
  workspaceKey: string;
  browserId: string;
}): boolean {
  const entry = useBrowserProvenanceStore.getState().takeClosed(input);
  if (!entry) {
    return false;
  }
  const { browserId } = createWorkspaceBrowser({ initialUrl: entry.url || undefined });
  useBrowserProvenanceStore.getState().humanOpened({ browserId });
  useWorkspaceLayoutStore
    .getState()
    .openTabFocused(input.workspaceKey, { kind: "browser", browserId });
  return true;
}
