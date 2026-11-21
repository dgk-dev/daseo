import { SETTINGS_DESKTOP_SPLIT_MIN_WIDTH } from "@/constants/layout";
import {
  MAX_EXPLORER_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "@/stores/panel-store";

export const MIN_DESKTOP_CENTER_WIDTH = 400;

export function resolveDesktopSidebarVisibility(input: {
  chromeEnabled: boolean;
  isCompactLayout: boolean;
  isMounted: boolean;
  isOpen: boolean;
  canShare: boolean;
}): boolean {
  return (
    input.chromeEnabled &&
    !input.isCompactLayout &&
    input.isMounted &&
    input.isOpen &&
    input.canShare
  );
}

export function resolveDesktopAppChromeLayout(input: {
  desktopSidebarRendered: boolean;
  hasTopLeftWindowControls: boolean;
  sidebarControlsEnabled: boolean;
}) {
  const sidebarOwnsTopLeft = input.desktopSidebarRendered && input.hasTopLeftWindowControls;
  let sidebarToggleOwner: "none" | "window" | "content" = "none";
  if (input.sidebarControlsEnabled) {
    sidebarToggleOwner = input.hasTopLeftWindowControls ? "window" : "content";
  }
  return {
    sidebarCorners: sidebarOwnsTopLeft ? ("top-left" as const) : ("none" as const),
    contentCorners: sidebarOwnsTopLeft ? ("top-right" as const) : ("both" as const),
    sidebarToggleOwner,
  };
}

function resolveDesktopPanelWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
  minimumWidth: number;
  maximumWidth: number;
}): number {
  "worklet";
  const maximumVisibleWidth = Math.max(
    input.minimumWidth,
    Math.min(input.maximumWidth, input.viewportWidth - MIN_DESKTOP_CENTER_WIDTH),
  );
  return Math.max(input.minimumWidth, Math.min(maximumVisibleWidth, input.requestedWidth));
}

export function resolveDesktopSidebarWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
}): number {
  "worklet";
  return resolveDesktopPanelWidth({
    ...input,
    minimumWidth: MIN_SIDEBAR_WIDTH,
    maximumWidth: MAX_SIDEBAR_WIDTH,
  });
}

export function resolveDesktopExplorerWidth(input: {
  requestedWidth: number;
  viewportWidth: number;
}): number {
  "worklet";
  return resolveDesktopPanelWidth({
    ...input,
    minimumWidth: MIN_EXPLORER_SIDEBAR_WIDTH,
    maximumWidth: MAX_EXPLORER_SIDEBAR_WIDTH,
  });
}

/**
 * What the app content needs beside the left sidebar. Where the task rail is docked by default
 * (the desktop app and the web) callers leave the rail out (`isWorkspaceExplorerOpen: false`): the
 * rail yields first there (`canDesktopTaskRailShare`), never the navigation. On the native wide
 * layout an open rail still counts, so the navigation yields to it as before.
 */
export function resolveDesktopAppContentMinimum(input: {
  isSettingsRoute: boolean;
  isWorkspaceExplorerOpen: boolean;
  requestedExplorerWidth: number;
  viewportWidth: number;
}): number {
  const workspaceMinimum = input.isWorkspaceExplorerOpen
    ? MIN_DESKTOP_CENTER_WIDTH +
      resolveDesktopExplorerWidth({
        requestedWidth: input.requestedExplorerWidth,
        viewportWidth: input.viewportWidth,
      })
    : 0;
  return Math.max(input.isSettingsRoute ? SETTINGS_DESKTOP_SPLIT_MIN_WIDTH : 0, workspaceMinimum);
}

/**
 * Whether the docked task rail has room: beside the left sidebar (when that is shown) it must
 * leave the centre its 400. Without room the rail is not drawn; its stored open state stays, so
 * it returns when the window widens or the left sidebar closes.
 */
export function canDesktopTaskRailShare(input: {
  viewportWidth: number;
  isSidebarShown: boolean;
  requestedSidebarWidth: number;
  requestedRailWidth: number;
}): boolean {
  const sidebarWidth = input.isSidebarShown
    ? resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: input.viewportWidth,
      })
    : 0;
  const railWidth = resolveDesktopExplorerWidth({
    requestedWidth: input.requestedRailWidth,
    viewportWidth: input.viewportWidth,
  });
  return input.viewportWidth - sidebarWidth - railWidth >= MIN_DESKTOP_CENTER_WIDTH;
}

export type TaskRailToggleEffect = "close" | "open" | "open-and-close-sidebar";

/**
 * What the rail's toggle does on a wide layout. A rail that is drawn closes. One that is not
 * drawn (closed, or open without room) is being asked for explicitly: it opens, and when the left
 * sidebar leaves it no room, that sidebar closes so the rail can show.
 */
export function resolveTaskRailToggle(input: {
  isOpen: boolean;
  hasRoom: boolean;
  hasRoomWithoutSidebar: boolean;
}): TaskRailToggleEffect {
  if (input.isOpen && input.hasRoom) return "close";
  if (input.hasRoom || !input.hasRoomWithoutSidebar) return "open";
  return "open-and-close-sidebar";
}

export function canDesktopAppSidebarShare(input: {
  contentMinimumWidth: number;
  requestedSidebarWidth: number;
  viewportWidth: number;
}): boolean {
  return (
    input.viewportWidth -
      resolveDesktopSidebarWidth({
        requestedWidth: input.requestedSidebarWidth,
        viewportWidth: input.viewportWidth,
      }) >=
    input.contentMinimumWidth
  );
}
