import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { PanelRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { usePanelStore, selectIsFileExplorerOpen } from "@/stores/panel-store";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useHasOwnedWindowChromeObstruction, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { TaskSectionsBody, useAgentTasks, useTaskBoard } from "@/composer/task-list/body";
import type { TodoEntry } from "@/types/stream";
import type { Theme } from "@/styles/theme";

const ThemedPanelRight = withUnistyles(PanelRight);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface TaskPanelProps {
  serverId: string;
  /** The agent session in the viewed tab, or null when the viewed tab is not one. */
  agentId: string | null;
}

/**
 * The right overlay on compact layouts. Daseo delta 101: like the wide sidebar it holds the viewed
 * session's task list (it held the Changes, Files, and PR tabs), and needs no workspace directory.
 */
export function CompactExplorerSidebar({ serverId, agentId }: TaskPanelProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: true,
  });
  const { gesture: closeGesture } = useCloseFileExplorerGesture();

  const handleHeaderClose = useCallback(() => {
    logExplorerSidebar("handleClose", {
      reason: "header-close-button",
      isOpen,
    });
    showMobileAgent();
  }, [isOpen, showMobileAgent]);

  const mobileSidebarStyle = useMemo(
    () => [
      {
        paddingTop: insets.top,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [insets.top, theme.colors.surfaceSidebar, mobileKeyboardInsetStyle],
  );

  return (
    <RetainedPanelActivity active={isOpen}>
      <MobilePanelOverlay
        panel="file-explorer"
        closeGesture={closeGesture}
        panelStyle={mobileSidebarStyle}
      >
        <TaskSidebarContent serverId={serverId} agentId={agentId} onClose={handleHeaderClose} />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}

/**
 * The right sidebar on wide layouts. Daseo delta 101: it keeps its toggle, width, resize, and
 * persisted open state, and holds the viewed session's task list instead of the Changes, Files, and
 * PR tabs (the explorer is retired from the UI; its panes stay in the tree for upstream
 * cherry-picks).
 */
export function ExplorerSidebar({ serverId, agentId }: TaskPanelProps) {
  const insets = useSafeAreaInsets();
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: false }));
  const { width: viewportWidth } = useWindowDimensions();
  const visibleExplorerWidth = resolveDesktopExplorerWidth({
    requestedWidth: explorerWidth,
    viewportWidth,
  });
  const startWidthRef = useRef(visibleExplorerWidth);
  const resizeWidth = useSharedValue(visibleExplorerWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleExplorerWidth;
  }, [resizeWidth, visibleExplorerWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // See the left sidebar's gesture: horizontal intent only, with the start
        // width anchored to the activation translation so the threshold is free.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleExplorerWidth + event.translationX;
          resizeWidth.value = visibleExplorerWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          resizeWidth.value = resolveDesktopExplorerWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setExplorerWidth,
      showResizeGrip,
      viewportWidth,
      visibleExplorerWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));
  const desktopSidebarStyle = useMemo(
    () => [explorerStaticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insets.top }],
    [resizeAnimatedStyle, insets.top],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={desktopSidebarStyle}>
      <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="explorer-sidebar-resize-handle"
        />

        {/* Daseo delta 113: no close control here; the workspace header's panel toggle closes it. */}
        <TaskSidebarContent serverId={serverId} agentId={agentId} />
      </View>
    </Animated.View>
  );
}

interface SidebarHeaderProps {
  children: ReactNode;
  /** Compact overlay only: it covers the workspace header, so it carries its own panel toggle. */
  onClose?: () => void;
}

/**
 * The sidebar's header row: the content's title slot on the left. Daseo delta 113: no `X` (it sat
 * in the window's top-right corner and read as quitting the app). On wide layouts the right slot is
 * empty and the workspace header's `PanelRight` toggle, which stays visible while the panel is
 * open, is the one control. The compact overlay covers that header, so it repeats the same
 * `PanelRight` button here, which closes the overlay.
 */
function SidebarHeader({ children, onClose }: SidebarHeaderProps) {
  const { theme } = useUnistyles();
  return (
    <WindowChromeSafeArea
      placement="inline"
      horizontalPadding={theme.spacing[2]}
      style={styles.header}
      testID="explorer-header"
    >
      <TitlebarDragRegion />
      {children}
      {onClose ? <SidebarHeaderPanelToggle onClose={onClose} /> : null}
    </WindowChromeSafeArea>
  );
}

function SidebarHeaderPanelToggle({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const hasRightWindowControls = useHasOwnedWindowChromeObstruction("top-right");
  if (hasRightWindowControls) return null;
  return (
    <Pressable
      onPress={onClose}
      style={styles.panelToggleButton}
      testID="explorer-close"
      nativeID="explorer-close"
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("workspace.tabs.tasks.close")}
      hitSlop={8}
    >
      {/* Open panel: the toggle is in its open (foreground) colour, as in the workspace header. */}
      <ThemedPanelRight size={20} uniProps={foregroundColorMapping} />
    </Pressable>
  );
}

interface TaskSidebarContentProps {
  serverId: string;
  agentId: string | null;
  onClose?: () => void;
}

// Daseo delta 101: the viewed session's task list, read-only, grouped by state.
function TaskSidebarContent({ serverId, agentId, onClose }: TaskSidebarContentProps) {
  const { t } = useTranslation();
  const tasks = useAgentTasks(serverId, agentId);

  if (!tasks?.length) {
    return (
      <View style={styles.sidebarContent} pointerEvents="auto">
        <SidebarHeader onClose={onClose}>
          <View style={styles.taskSummarySlot} />
        </SidebarHeader>
        <View style={styles.emptyContainer} testID="task-sidebar-empty">
          <Text style={styles.emptyText}>{t("workspace.tabs.tasks.empty")}</Text>
        </View>
      </View>
    );
  }
  return <TaskSidebarBoard tasks={tasks} onClose={onClose} />;
}

function TaskSidebarBoard({ tasks, onClose }: { tasks: TodoEntry[]; onClose?: () => void }) {
  // The sections below show the task in progress and count what waits and what is held.
  const { label } = useTaskBoard(tasks, { withCurrent: false, withStateCounts: false });
  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      <SidebarHeader onClose={onClose}>
        <View style={styles.taskSummarySlot}>
          <Text
            style={styles.taskSummary}
            numberOfLines={1}
            accessibilityRole="header"
            testID="task-sidebar-summary"
          >
            {label}
          </Text>
        </View>
      </SidebarHeader>
      <ScrollView style={styles.contentArea} testID="task-sidebar-list">
        <TaskSectionsBody tasks={tasks} />
      </ScrollView>
    </View>
  );
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const explorerStaticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  panelToggleButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
  // Daseo delta 101: the task summary sits where the tabs were; its text lines up with the rows.
  taskSummarySlot: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[1],
  },
  taskSummary: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  // The Changes pane's empty state, the sibling in this sidebar.
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
  },
}));
