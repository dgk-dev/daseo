import { useCallback } from "react";
import { useWindowDimensions } from "react-native";
import {
  canDesktopTaskRailShare,
  resolveTaskRailToggle,
} from "@/components/desktop-sidebar-layout";
import { isWeb } from "@/constants/platform";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { isTaskRailDockedByDefault } from "@/stores/panel-store/state";

// Where the rail is docked by default (the desktop app and the web) it yields to the left sidebar.
// On the native wide layout (an unfolded Fold: 875 wide, where 260 + 240 + 400 never fit) the rail
// is opened on purpose and the navigation yields to it, as before.
const RAIL_YIELDS_FIRST = isTaskRailDockedByDefault(isWeb);

/**
 * Whether the wide layout has room for the docked task rail beside the left sidebar. The rail
 * yields first: it is drawn only when the centre keeps its 400.
 */
export function useTaskRailHasRoom(): boolean {
  const { width: viewportWidth } = useWindowDimensions();
  const isSidebarShown = usePanelStore((state) => state.desktop.agentListOpen);
  const requestedSidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const requestedRailWidth = usePanelStore((state) => state.explorerWidth);
  return (
    !RAIL_YIELDS_FIRST ||
    canDesktopTaskRailShare({
      viewportWidth,
      isSidebarShown,
      requestedSidebarWidth,
      requestedRailWidth,
    })
  );
}

/** Whether the right panel is on screen: the compact overlay open, or the wide rail open with room. */
export function useIsTaskPanelShown(isCompact: boolean): boolean {
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact }));
  const hasRoom = useTaskRailHasRoom();
  return isOpen && (isCompact || hasRoom);
}

/**
 * The right panel's toggle (header button and `Cmd+E`). Compact: the overlay opens and closes. Wide:
 * see `resolveTaskRailToggle`; asking for a rail that has no room closes the left sidebar.
 */
export function useToggleTaskPanel(isCompact: boolean): () => void {
  const { width: viewportWidth } = useWindowDimensions();
  return useCallback(() => {
    const store = usePanelStore.getState();
    if (isCompact) {
      store.toggleFileExplorerForLayout({ isCompact: true });
      return;
    }
    const room = (isSidebarShown: boolean) =>
      !RAIL_YIELDS_FIRST ||
      canDesktopTaskRailShare({
        viewportWidth,
        isSidebarShown,
        requestedSidebarWidth: store.sidebarWidth,
        requestedRailWidth: store.explorerWidth,
      });
    const effect = resolveTaskRailToggle({
      isOpen: store.desktop.fileExplorerOpen,
      hasRoom: room(store.desktop.agentListOpen),
      hasRoomWithoutSidebar: room(false),
    });
    if (effect === "close") {
      store.closeDesktopFileExplorer();
      return;
    }
    store.openFileExplorerForLayout({ isCompact: false });
    if (effect === "open-and-close-sidebar") store.closeDesktopAgentList();
  }, [isCompact, viewportWidth]);
}
