import { type ReactNode, useCallback, useEffect } from "react";
import { View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { CompactExplorerSidebar } from "@/components/explorer-sidebar";
import { useOpenFileExplorerGesture } from "@/mobile-panels/gestures";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveWorkspaceViewedAgentId } from "@/task-sidebar/viewed-agent";
import { isWeb } from "@/constants/platform";

interface CompactExplorerOpenGestureSurfaceProps {
  children: ReactNode;
  enabled: boolean;
  onOpenExplorer: () => void;
}

const COMPACT_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

function CompactExplorerOpenGestureSurface({
  children,
  enabled,
  onOpenExplorer,
}: CompactExplorerOpenGestureSurfaceProps) {
  const explorerOpenGesture = useOpenFileExplorerGesture({
    enabled,
    onOpen: onOpenExplorer,
  });

  return (
    <GestureDetector gesture={explorerOpenGesture} touchAction={COMPACT_WEB_GESTURE_TOUCH_ACTION}>
      <View style={styles.fill}>{children}</View>
    </GestureDetector>
  );
}

interface CompactTaskPanelTarget {
  serverId: string;
  /** The agent session in the active workspace's viewed tab, or null when it is not one. */
  agentId: string | null;
}

/**
 * Daseo delta 101: the compact right panel shows the task list of the viewed tab's agent session in
 * the active workspace. It needs only the selection and the workspace layout, so it starts no
 * checkout, file-tree, diff, branch, or PR request.
 */
function useActiveCompactTaskPanelTarget(enabled: boolean): CompactTaskPanelTarget | null {
  const selection = useActiveWorkspaceSelection();
  const isPanelOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: true }),
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const persistenceKey = selection
    ? buildWorkspaceTabPersistenceKey({
        serverId: selection.serverId,
        workspaceId: selection.workspaceId,
      })
    : null;
  const agentId = useWorkspaceLayoutStore((state) =>
    persistenceKey
      ? resolveWorkspaceViewedAgentId(state.layoutByWorkspace[persistenceKey] ?? null)
      : null,
  );

  useEffect(() => {
    if (!persistenceKey && enabled && isPanelOpen) {
      showMobileAgent();
    }
  }, [enabled, isPanelOpen, persistenceKey, showMobileAgent]);

  if (!selection || !persistenceKey) {
    return null;
  }
  return { serverId: selection.serverId, agentId };
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
}

export function CompactExplorerSidebarHost({ children, enabled }: CompactExplorerSidebarHostProps) {
  const target = useActiveCompactTaskPanelTarget(enabled);
  const openFileExplorerForLayout = usePanelStore((state) => state.openFileExplorerForLayout);

  const handleOpenPanel = useCallback(() => {
    openFileExplorerForLayout({ isCompact: true });
  }, [openFileExplorerForLayout]);

  return (
    <>
      <CompactExplorerOpenGestureSurface
        enabled={enabled && target !== null}
        onOpenExplorer={handleOpenPanel}
      >
        {children}
      </CompactExplorerOpenGestureSurface>
      {enabled && target ? (
        <CompactExplorerSidebar serverId={target.serverId} agentId={target.agentId} />
      ) : null}
    </>
  );
}

const styles = {
  fill: {
    flex: 1,
  },
} as const;
