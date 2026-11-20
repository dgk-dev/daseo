import { getDesktopHost } from "@/desktop/host";

/**
 * Daseo delta 137: tells the desktop main process that the daemon removed these workspaces
 * (archived from any client), so it discards their browser tabs at once. The tabs stay in the workspace's layout and reload when shown or used again.
 * Nothing happens outside the Electron app.
 */
export function discardBrowserTabsOfArchivedWorkspaces(workspaceIds: readonly string[]): void {
  if (workspaceIds.length === 0) {
    return;
  }
  const discard = getDesktopHost()?.browser?.discardArchivedWorkspaceTabs;
  if (!discard) {
    return;
  }
  void discard([...workspaceIds]).catch((error: unknown) => {
    console.warn("[browser-lifecycle] archived workspace tab discard failed", error);
  });
}
