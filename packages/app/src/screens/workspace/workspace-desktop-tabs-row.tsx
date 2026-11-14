import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  Pencil,
  RotateCw,
  Globe,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useRouter, type Href } from "expo-router";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type {
  DraggableListDragHandleProps,
  DraggableRenderItemInfo,
} from "@/components/draggable-list.types";
import { isNative, isWeb } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabStatusMark,
  formatWorkspaceTabIndex,
  resolveWorkspaceTabTitle,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { HINT_LINE_CARET, HintWord } from "@/composer/hint-line";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { STATUS_RING_FRAME_SIZE } from "@/components/status-ring/geometry";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildWorkspaceDesktopTabActions,
  type WorkspaceDesktopTabActions,
  type WorkspaceTabMenuEntry,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { Theme } from "@/styles/theme";
import { RenderProfile } from "@/utils/render-profiler";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { TerminalProfileInput } from "@/screens/workspace/terminals/use-workspace-terminals";
import { ProfileIcon, usePinnedLaunchers, type ResolvedPin } from "@/workspace-pins/launch";
import { runPinnedTabTarget, type TabTargetHandlers } from "@/workspace-pins/run";
import { pinnedTargetKey, type PinnedTabTarget } from "@/workspace-pins/target";
import { PinnableMenuItem } from "@/workspace-pins/pinnable-menu-item";
import { getIsElectron } from "@/constants/platform";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  useRecentlyClosedBrowsers,
  type RecentlyClosedBrowser,
} from "@/desktop/browser/provenance";
import { reopenRecentlyClosedBrowser } from "@/desktop/browser/provenance/reopen";

const DROPDOWN_WIDTH = 220;
const LOADING_TAB_LABEL_SKELETON_WIDTH = 80;
const DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH = 28;
// Tab geometry, shared by the styles and the width budget in `useWorkspaceTabLayout`. The
// leading width is the `N:` index and the status-mark slot, each with the gap after it. The
// slot is budgeted whether or not the tab has a mark, so a running tab still gets its full
// title floor.
const TAB_HORIZONTAL_PADDING = 8;
const TAB_HANDLE_GAP = 4;
const TAB_INDEX_WIDTH = 22;
const TAB_LEADING_WIDTH = TAB_INDEX_WIDTH + STATUS_RING_FRAME_SIZE + TAB_HANDLE_GAP;
const TAB_CLOSE_SLOT_SIZE = 14;
const TAB_CLOSE_SLOT_GAP = 6;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedSquarePen = withUnistyles(SquarePen);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedGlobe = withUnistyles(Globe);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.accentForeground,
});

const AGENT_ICON = <ThemedSquarePen size={14} uniProps={mutedColorMapping} />;
const TERMINAL_ICON = <ThemedSquareTerminal size={14} uniProps={mutedColorMapping} />;
const BROWSER_ICON = <ThemedGlobe size={14} uniProps={mutedColorMapping} />;

const DRAFT_TARGET: PinnedTabTarget = { kind: "draft" };
const TERMINAL_TARGET: PinnedTabTarget = { kind: "terminal" };
const BROWSER_TARGET: PinnedTabTarget = { kind: "browser" };

// Daseo delta 112: the tab row reads like a tmux status line. Tabs are `N:title` text, the active
// one in reverse video, and the controls on the right are words in the composer hint line's type
// (`▾ web term vsplit hsplit`, vim's names for the splits). The words are command vocabulary and
// stay English in every locale; accessibility labels and tooltips stay translated.
const TAB_ROW_WORDS = {
  newTab: "+",
  close: "×",
  menu: HINT_LINE_CARET,
  agent: "agent",
  term: "term",
  web: "web",
  vsplit: "vsplit",
  hsplit: "hsplit",
} as const;

/** The word for a pinned launcher; a pinned terminal profile is its name. */
function pinnedLauncherWord(launcher: ResolvedPin): string {
  switch (launcher.key) {
    case pinnedTargetKey(TERMINAL_TARGET):
      return TAB_ROW_WORDS.term;
    case pinnedTargetKey(BROWSER_TARGET):
      return TAB_ROW_WORDS.web;
    case pinnedTargetKey(DRAFT_TARGET):
      return TAB_ROW_WORDS.agent;
    default:
      return launcher.label.toLowerCase();
  }
}

function inlineAddButtonStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.inlineAddActionButton, (hovered || pressed) && styles.tabHovered];
}

function exitFocusModeButtonStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.exitFocusModeButton, (hovered || pressed) && styles.tabHovered];
}

interface TabRowWordButtonProps {
  word: string;
  label: string;
  onPress: () => void;
  shortcutKeys?: ShortcutKey[][] | null;
  testID?: string;
}

/** A right-side control: one word, muted until hovered or pressed, with its tooltip. */
function TabRowWordButton({ word, label, onPress, shortcutKeys, testID }: TabRowWordButtonProps) {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.wordButton}
      >
        {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
          <HintWord active={Boolean(hovered) || pressed}>{word}</HintWord>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <View style={styles.newTabTooltipRow}>
          <Text style={styles.newTabTooltipText}>{label}</Text>
          {shortcutKeys ? (
            <Shortcut chord={shortcutKeys} style={styles.newTabTooltipShortcut} />
          ) : null}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function updateMeasuredWidth(setWidth: Dispatch<SetStateAction<number>>, event: LayoutChangeEvent) {
  const nextWidth = Math.round(event.nativeEvent.layout.width);
  setWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
}

function ProfileLeadingIcon({ iconKey }: { iconKey: string | undefined }) {
  return (
    <View style={styles.terminalProfileIconWrapper}>
      <ProfileIcon iconKey={iconKey} />
    </View>
  );
}

interface PinnableProfileMenuItemProps {
  profile: { id: string; name: string; command: string; args?: string[]; icon?: string };
  disabled?: boolean;
  onLaunch: (target: PinnedTabTarget) => void;
}

function PinnableProfileMenuItem({ profile, disabled, onLaunch }: PinnableProfileMenuItemProps) {
  const target = useMemo<PinnedTabTarget>(
    () => ({ kind: "profile", profileId: profile.id }),
    [profile.id],
  );
  const leading = useMemo(
    () => <ProfileLeadingIcon iconKey={getTerminalProfileIcon(profile)} />,
    [profile],
  );
  const handleSelect = useCallback(() => onLaunch(target), [onLaunch, target]);

  return (
    <PinnableMenuItem
      target={target}
      label={profile.name}
      leading={leading}
      disabled={disabled}
      onSelect={handleSelect}
    />
  );
}

interface WorkspaceInlineAddTabButtonProps {
  shortcutKeys: ShortcutKey[][] | null;
  onCreateAgentTab: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}

function WorkspaceInlineAddTabButton({
  shortcutKeys,
  onCreateAgentTab,
  onLayout,
}: WorkspaceInlineAddTabButtonProps) {
  const { t } = useTranslation();
  const tooltipText = t("workspace.tabs.actions.newAgent");

  return (
    <View style={styles.inlineAddButton} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID="workspace-new-agent-tab-inline"
          onPress={onCreateAgentTab}
          accessibilityRole="button"
          accessibilityLabel={tooltipText}
          style={inlineAddButtonStyle}
        >
          {({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
            <Text
              style={Boolean(hovered) || pressed ? styles.newTabGlyphActive : styles.newTabGlyph}
              selectable={false}
              dataSet={CODE_SURFACE_DATASET}
            >
              {TAB_ROW_WORDS.newTab}
            </Text>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.newTabTooltipRow}>
            <Text style={styles.newTabTooltipText}>{tooltipText}</Text>
            {shortcutKeys ? (
              <Shortcut chord={shortcutKeys} style={styles.newTabTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

interface WorkspaceTabRowExtrasProps {
  onCreateAgentTab: () => void;
  onCreateTerminal: () => void;
  onCreateBrowser: () => void;
  onCreateTerminalWithProfile: (profile: TerminalProfileInput) => void;
  onEditProfiles: () => void;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  showCreateBrowserTab: boolean;
  terminalDisabled: boolean;
}

/** Delta 98: at most this many recently closed tabs in the menu, newest first. */
const RECENTLY_CLOSED_MENU_LIMIT = 10;

function recentlyClosedLabel(entry: RecentlyClosedBrowser): string {
  if (entry.title.trim()) return entry.title.trim();
  try {
    return new URL(entry.url).host || entry.url;
  } catch {
    return entry.url;
  }
}

function RecentlyClosedMenuItem({
  entry,
  workspaceKey,
}: {
  entry: RecentlyClosedBrowser;
  workspaceKey: string;
}) {
  const handleSelect = useCallback(() => {
    reopenRecentlyClosedBrowser({ workspaceKey, browserId: entry.browserId });
  }, [entry.browserId, workspaceKey]);
  return (
    <DropdownMenuItem
      testID={`workspace-new-tab-menu-reopen-${entry.browserId}`}
      onSelect={handleSelect}
    >
      {recentlyClosedLabel(entry)}
    </DropdownMenuItem>
  );
}

function WorkspaceTabRowExtras({
  onCreateAgentTab,
  onCreateTerminal,
  onCreateBrowser,
  onCreateTerminalWithProfile,
  onEditProfiles,
  normalizedServerId,
  normalizedWorkspaceId,
  showCreateBrowserTab,
  terminalDisabled,
}: WorkspaceTabRowExtrasProps) {
  const { t } = useTranslation();
  // Delta 98: tabs the agent-tab auto-close closed here, reopenable for 14 days. Nothing shows
  // until a tab has been closed that way.
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const recentlyClosed = useRecentlyClosedBrowsers(
    showCreateBrowserTab && getIsElectron() ? workspaceKey : null,
  );
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  const handlers = useMemo<TabTargetHandlers>(
    () => ({
      createDraft: onCreateAgentTab,
      createTerminal: onCreateTerminal,
      createBrowser: onCreateBrowser,
      createTerminalWithProfile: onCreateTerminalWithProfile,
    }),
    [onCreateAgentTab, onCreateBrowser, onCreateTerminal, onCreateTerminalWithProfile],
  );

  const onLaunch = useCallback(
    (target: PinnedTabTarget) => {
      runPinnedTabTarget(target, profiles, handlers);
    },
    [handlers, profiles],
  );

  const launchers = usePinnedLaunchers({ serverId: normalizedServerId, onLaunch });

  return (
    <>
      <DropdownMenu>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <DropdownMenuTrigger
              testID="workspace-new-tab-menu-trigger"
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.actions.moreActions")}
              style={styles.wordButton}
            >
              {({ hovered, pressed, open }) => (
                <HintWord active={hovered || pressed || open}>{TAB_ROW_WORDS.menu}</HintWord>
              )}
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <Text style={styles.newTabTooltipText}>{t("workspace.tabs.actions.moreActions")}</Text>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="end" offset={4} minWidth={200}>
          <PinnableMenuItem
            testID="workspace-new-tab-menu-agent"
            target={DRAFT_TARGET}
            label={t("workspace.tabs.actions.newAgent")}
            leading={AGENT_ICON}
            onSelect={onCreateAgentTab}
          />
          <PinnableMenuItem
            testID="workspace-new-tab-menu-terminal"
            target={TERMINAL_TARGET}
            label={t("workspace.tabs.actions.newTerminal")}
            leading={TERMINAL_ICON}
            disabled={terminalDisabled}
            onSelect={terminalDisabled ? undefined : onCreateTerminal}
          />
          {showCreateBrowserTab ? (
            <PinnableMenuItem
              testID="workspace-new-tab-menu-browser"
              target={BROWSER_TARGET}
              label={t("workspace.tabs.actions.newBrowser")}
              leading={BROWSER_ICON}
              onSelect={onCreateBrowser}
            />
          ) : null}
          {workspaceKey && recentlyClosed.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {t("workspace.tabs.actions.recentlyClosedTabs")}
              </DropdownMenuLabel>
              {recentlyClosed.slice(0, RECENTLY_CLOSED_MENU_LIMIT).map((entry) => (
                <RecentlyClosedMenuItem
                  key={entry.browserId}
                  entry={entry}
                  workspaceKey={workspaceKey}
                />
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
          {profiles.map((profile) => (
            <PinnableProfileMenuItem
              key={profile.id}
              profile={profile}
              disabled={terminalDisabled}
              onLaunch={onLaunch}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem testID="workspace-new-tab-menu-edit-profiles" onSelect={onEditProfiles}>
            {t("workspace.tabs.actions.editTerminalProfiles")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {launchers.map((launcher) => (
        <TabRowWordButton
          key={launcher.key}
          testID={`workspace-pinned-target-${launcher.key}`}
          word={pinnedLauncherWord(launcher)}
          label={launcher.label}
          onPress={launcher.onPress}
        />
      ))}
    </>
  );
}

function TabContextMenuItem({
  entry,
}: {
  entry: Extract<WorkspaceTabMenuEntry, { kind: "item" }>;
}) {
  const leading = useMemo(() => {
    switch (entry.icon) {
      case "copy":
        return <ThemedCopy size={16} uniProps={mutedColorMapping} />;
      case "rotate-cw":
        return <ThemedRotateCw size={16} uniProps={mutedColorMapping} />;
      case "arrow-left-to-line":
        return <ThemedArrowLeftToLine size={16} uniProps={mutedColorMapping} />;
      case "arrow-right-to-line":
        return <ThemedArrowRightToLine size={16} uniProps={mutedColorMapping} />;
      case "copy-x":
        return <ThemedCopyX size={16} uniProps={mutedColorMapping} />;
      case "pencil":
        return <ThemedPencil size={16} uniProps={mutedColorMapping} />;
      case "x":
        return <ThemedX size={16} uniProps={mutedColorMapping} />;
      default:
        return undefined;
    }
  }, [entry.icon]);
  const trailing = useMemo(
    () => (entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined),
    [entry.hint],
  );
  return (
    <ContextMenuItem
      testID={entry.testID}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
      tooltip={entry.tooltip}
      leading={leading}
      trailing={trailing}
    >
      {entry.label}
    </ContextMenuItem>
  );
}

function tabKeyExtractor(tab: WorkspaceDesktopTabRowItem) {
  return `${tab.tab.key}:${tab.tab.kind}`;
}

export interface WorkspaceDesktopTabRowItem {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
}

interface WorkspaceDesktopTabsRowProps {
  paneId?: string;
  isFocused?: boolean;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onCreateDraftTab: (input: { paneId?: string }) => void;
  onCreateTerminalTab: (input: { paneId?: string; profile?: TerminalProfileInput }) => void;
  onCreateBrowserTab: (input: { paneId?: string }) => void;
  showCreateBrowserTab?: boolean;
  disableCreateTerminal?: boolean;
  isWaitingOnTerminalReadiness?: boolean;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showPaneSplitActions?: boolean;
  focusModeEnabled: boolean;
  onExitFocusMode: () => void;
}

function useMiddleClickClose(onClose: () => void) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (isNative) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;

    function handleAuxClick(event: MouseEvent) {
      if (event.button === 1) {
        event.preventDefault();
        onClose();
      }
    }

    node.addEventListener("auxclick", handleAuxClick);
    return () => node.removeEventListener("auxclick", handleAuxClick);
  }, [onClose]);

  return ref;
}

/**
 * How a tab is drawn (Daseo delta 112). The active tab of the focused pane is reverse video in the
 * accent; the active tab of a pane that is not focused is reversed in the muted foreground, so
 * the focused pane stays obvious; every other tab is muted text on the bar.
 */
type TabTone = "active" | "activeUnfocused" | "idle";

function resolveTabTone({ isActive, isFocused }: { isActive: boolean; isFocused: boolean }) {
  if (!isActive) return "idle";
  return isFocused ? "active" : "activeUnfocused";
}

function TabHandleContent({
  position,
  presentation,
  tone,
  showLabel,
  tabLabelSkeletonStyle,
}: {
  position: number;
  presentation: WorkspaceTabPresentation;
  tone: TabTone;
  showLabel: boolean;
  tabLabelSkeletonStyle: React.ComponentProps<typeof View>["style"];
}) {
  const tabHandleDataSet = useMemo(
    () => ({ statusBucket: presentation.statusBucket ?? "none" }),
    [presentation.statusBucket],
  );
  const reversed = tone !== "idle";

  return (
    <View style={styles.tabHandle} dataSet={tabHandleDataSet}>
      <Text
        style={reversed ? styles.tabIndexReversed : styles.tabIndex}
        selectable={false}
        dataSet={CODE_SURFACE_DATASET}
      >
        {formatWorkspaceTabIndex(position)}
      </Text>
      <WorkspaceTabStatusMark presentation={presentation} backdrop={reversed ? "surface0" : null} />
      {showLabel && presentation.titleState === "loading" ? (
        <View style={tabLabelSkeletonStyle} />
      ) : null}
      {showLabel && presentation.titleState !== "loading" ? (
        <Text
          style={reversed ? styles.tabLabelReversed : styles.tabLabel}
          selectable={false}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {resolveWorkspaceTabTitle(presentation)}
        </Text>
      ) : null}
    </View>
  );
}

function TabCloseSlotContent({
  tabTarget,
  tone,
  isClosingTab,
  isModified,
  isCloseVisible,
  closeHovered,
}: {
  tabTarget: WorkspaceTabDescriptor["target"];
  tone: TabTone;
  isClosingTab: boolean;
  isModified: boolean;
  isCloseVisible: boolean;
  closeHovered: boolean;
}) {
  const { t } = useTranslation();
  const reversed = tone !== "idle";
  if (isClosingTab) {
    return (
      <ThemedLoadingSpinner
        size={12}
        uniProps={reversed ? accentForegroundColorMapping : mutedColorMapping}
      />
    );
  }
  if (isModified && !closeHovered) {
    return (
      <View
        style={reversed ? styles.tabModifiedDotReversed : styles.tabModifiedDot}
        accessibilityLabel={t("workspace.tabs.modified")}
        testID={`workspace-tab-modified-${buildDeterministicWorkspaceTabId(tabTarget)}`}
      />
    );
  }
  let glyphStyle = styles.tabCloseGlyph;
  if (reversed) glyphStyle = styles.tabCloseGlyphReversed;
  else if (closeHovered) glyphStyle = styles.tabCloseGlyphHovered;
  return (
    <Text
      style={[glyphStyle, !isCloseVisible && styles.tabCloseGlyphHidden]}
      selectable={false}
      dataSet={CODE_SURFACE_DATASET}
    >
      {TAB_ROW_WORDS.close}
    </Text>
  );
}

function TabChip({
  tab,
  position,
  isActive,
  isDragging,
  isFocused,
  resolvedTabWidth,
  showLabel,
  isCloseHovered,
  isClosingTab,
  presentation,
  tooltipLabel,
  resolvedTab,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  tab: WorkspaceTabDescriptor;
  position: number;
  isActive: boolean;
  isDragging: boolean;
  isFocused: boolean;
  resolvedTabWidth: number;
  showLabel: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  presentation: WorkspaceTabPresentation;
  tooltipLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { closeButtonTestId, contextMenuTestId, menuEntries } = resolvedTab;
  const middleClickRef = useMiddleClickClose(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
  );
  const [hovered, setHovered] = useState(false);
  const tone = resolveTabTone({ isActive, isFocused });
  const isHovered = hovered || isCloseHovered;
  // The close slot is always laid out, so hovering never shifts the row; the × only shows on the
  // active tab and on a hovered one. A hidden × takes no presses, so a tap on that spot of an
  // inactive tab on a touch screen selects the tab instead of closing it.
  const isCloseVisible = isActive || isHovered || isClosingTab;
  const isCloseInteractive = isCloseVisible || presentation.modified;
  const closeButtonDragBlockers = isWeb
    ? ({
        onPointerDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
        onMouseDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
      } as const)
    : undefined;

  const tabChipStyle = useCallback(
    () => [
      styles.tab,
      tone === "active" && styles.tabActive,
      tone === "activeUnfocused" && styles.tabActiveUnfocused,
      tone === "idle" && isHovered && styles.tabHovered,
      isWeb && isDragging && ({ cursor: "grabbing" } as object),
      { maxWidth: resolvedTabWidth },
    ],
    [isDragging, isHovered, resolvedTabWidth, tone],
  );

  const handleTabHoverIn = useCallback(() => {
    setHovered(true);
  }, []);

  const handleTabHoverOut = useCallback(() => {
    setHovered(false);
  }, []);

  const handleNavigateTab = useCallback(() => {
    onNavigateTab(tab.tabId);
  }, [onNavigateTab, tab.tabId]);

  const handleCloseButtonPressIn = useCallback((event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
  }, []);

  const handleCloseButtonHoverIn = useCallback(() => {
    setHoveredCloseTabKey(tab.key);
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonHoverOut = useCallback(() => {
    setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonPress = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      void onCloseTab(tab.tabId);
    },
    [onCloseTab, tab.tabId],
  );

  const tabAccessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const tabLabelSkeletonStyle = useMemo(
    () => [styles.tabLabelSkeleton, styles.tabLabelSkeletonWithCloseButton],
    [],
  );

  return (
    <View ref={middleClickRef}>
      <ContextMenu key={tab.key}>
        <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              testID={`workspace-tab-${buildDeterministicWorkspaceTabId(tab.target)}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as unknown as undefined}
              enabledOnMobile={false}
              style={tabChipStyle}
              onHoverIn={handleTabHoverIn}
              onHoverOut={handleTabHoverOut}
              onPressIn={handleNavigateTab}
              onPress={handleNavigateTab}
              accessibilityRole="button"
              accessibilityLabel={tooltipLabel}
              accessibilityState={tabAccessibilityState}
              aria-selected={isActive}
            >
              <TabHandleContent
                position={position}
                presentation={presentation}
                tone={tone}
                showLabel={showLabel}
                tabLabelSkeletonStyle={tabLabelSkeletonStyle}
              />

              <Pressable
                {...(closeButtonDragBlockers as object | undefined)}
                testID={closeButtonTestId}
                disabled={isClosingTab || !isCloseInteractive}
                onPressIn={handleCloseButtonPressIn}
                onHoverIn={handleCloseButtonHoverIn}
                onHoverOut={handleCloseButtonHoverOut}
                onPress={handleCloseButtonPress}
                style={isCloseInteractive ? styles.tabCloseButton : styles.tabCloseButtonInert}
              >
                {({ hovered: closeHovered, pressed }) => (
                  <TabCloseSlotContent
                    tabTarget={tab.target}
                    tone={tone}
                    isClosingTab={isClosingTab}
                    isModified={presentation.modified}
                    isCloseVisible={isCloseVisible}
                    closeHovered={Boolean(closeHovered) || pressed}
                  />
                )}
              </Pressable>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            offset={8}
            maxWidth={720}
            testID={`workspace-tab-tooltip-${buildDeterministicWorkspaceTabId(tab.target)}`}
          >
            {tab.target.kind === "agent" ? (
              <View style={styles.tooltipAgentRow}>
                <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
                <Text style={styles.tooltipAgentId}>{tab.target.agentId.slice(0, 7)}</Text>
              </View>
            ) : (
              <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
            )}
          </TooltipContent>
        </Tooltip>

        <ContextMenuContent align="start" width={DROPDOWN_WIDTH} testID={contextMenuTestId}>
          {menuEntries.map((entry) =>
            entry.kind === "separator" ? (
              <ContextMenuSeparator key={entry.key} />
            ) : (
              <TabContextMenuItem key={entry.key} entry={entry} />
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

export function WorkspaceDesktopTabsRow({
  paneId,
  isFocused = false,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  onCreateBrowserTab,
  showCreateBrowserTab = false,
  disableCreateTerminal = false,
  isWaitingOnTerminalReadiness = false,
  onReorderTabs,
  onSplitRight,
  onSplitDown,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showPaneSplitActions = true,
  focusModeEnabled,
  onExitFocusMode,
}: WorkspaceDesktopTabsRowProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const newTabKeys = useShortcutKeys("workspace-tab-new");
  const focusModeKeys = useShortcutKeys("toggle-focus");
  const splitRightKeys = useShortcutKeys("workspace-pane-split-right");
  const splitDownKeys = useShortcutKeys("workspace-pane-split-down");
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const [tabsActionsWidth, setTabsActionsWidth] = useState<number>(0);
  const [inlineAddButtonWidth, setInlineAddButtonWidth] = useState<number>(0);
  const [exitFocusModeWidth, setExitFocusModeWidth] = useState<number>(0);

  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsContainerWidth, event);
  }, []);

  const handleTabsActionsLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsActionsWidth, event);
  }, []);

  const handleInlineAddButtonLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setInlineAddButtonWidth, event);
  }, []);

  const handleExitFocusModeLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setExitFocusModeWidth, event);
  }, []);

  const layoutMetrics = useMemo(
    () => ({
      rowHorizontalInset: 0,
      actionsReservedWidth: Math.max(
        0,
        tabsActionsWidth +
          (inlineAddButtonWidth || DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH) +
          (focusModeEnabled ? exitFocusModeWidth : 0),
      ),
      rowPaddingHorizontal: 0,
      tabGap: 0,
      maxTabWidth: 200,
      tabLeadingWidth: TAB_LEADING_WIDTH,
      tabHorizontalPadding: TAB_HORIZONTAL_PADDING,
      estimatedCharWidth: 7,
      closeButtonWidth: TAB_CLOSE_SLOT_SIZE + TAB_CLOSE_SLOT_GAP,
    }),
    [exitFocusModeWidth, focusModeEnabled, inlineAddButtonWidth, tabsActionsWidth],
  );

  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const activeTabIndex = tabs.findIndex((tab) => tab.isActive);
  const { layout } = useWorkspaceTabLayout({
    tabCount: tabs.length,
    activeIndex: activeTabIndex,
    viewportWidthOverride: tabsContainerWidth > 0 ? tabsContainerWidth : null,
    metrics: layoutMetrics,
  });

  // When the row scrolls, keep the active tab in view: it always carries its title (delta 112),
  // so the scroll position is what decides whether that title can be read.
  const tabsScrollRef = useRef<ScrollView>(null);
  const tabsScrollXRef = useRef(0);
  const [tabsScrollViewportWidth, setTabsScrollViewportWidth] = useState(0);
  const [tabWidths, setTabWidths] = useState<Record<string, number>>({});

  const handleTabsScrollLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsScrollViewportWidth, event);
  }, []);

  const handleTabsScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    tabsScrollXRef.current = event.nativeEvent.contentOffset.x;
  }, []);

  const handleTabSlotLayout = useCallback((tabKey: string, width: number) => {
    const nextWidth = Math.round(width);
    setTabWidths((current) =>
      Math.abs((current[tabKey] ?? -2) - nextWidth) > 1
        ? { ...current, [tabKey]: nextWidth }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!layout.requiresHorizontalScrollFallback || activeTabIndex < 0) return;
    if (tabsScrollViewportWidth <= 0) return;
    let activeStart = 0;
    for (let index = 0; index < activeTabIndex; index += 1) {
      const width = tabWidths[tabs[index]?.tab.key ?? ""];
      if (width === undefined) return;
      activeStart += width;
    }
    const activeWidth = tabWidths[tabs[activeTabIndex]?.tab.key ?? ""];
    if (activeWidth === undefined) return;
    const current = tabsScrollXRef.current;
    let target = current;
    if (activeStart < current) target = activeStart;
    else if (activeStart + activeWidth > current + tabsScrollViewportWidth) {
      target = activeStart + activeWidth - tabsScrollViewportWidth;
    }
    if (target !== current) {
      tabsScrollRef.current?.scrollTo({ x: target, animated: false });
      tabsScrollXRef.current = target;
    }
  }, [
    activeTabIndex,
    layout.requiresHorizontalScrollFallback,
    tabWidths,
    tabs,
    tabsScrollViewportWidth,
  ]);

  const handleDragEnd = useCallback(
    (nextTabs: WorkspaceDesktopTabRowItem[]) => {
      onReorderTabs(nextTabs.map((tab) => tab.tab));
    },
    [onReorderTabs],
  );

  const getTabDragData = useMemo(() => {
    if (!paneId) return undefined;
    return (tab: WorkspaceDesktopTabRowItem) => ({
      kind: "workspace-tab" as const,
      paneId,
      tabId: tab.tab.tabId,
    });
  }, [paneId]);

  const handleCreateAgentTab = useCallback(() => {
    onCreateDraftTab({ paneId });
  }, [onCreateDraftTab, paneId]);

  const handleCreateTerminal = useCallback(() => {
    onCreateTerminalTab({ paneId });
  }, [onCreateTerminalTab, paneId]);

  const handleCreateTerminalWithProfile = useCallback(
    (profile: TerminalProfileInput) => {
      onCreateTerminalTab({ paneId, profile });
    },
    [onCreateTerminalTab, paneId],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);

  const handleCreateBrowser = useCallback(() => {
    onCreateBrowserTab({ paneId });
  }, [onCreateBrowserTab, paneId]);

  const terminalDisabled = disableCreateTerminal || isWaitingOnTerminalReadiness;

  const renderTab = useCallback(
    ({
      item,
      index,
      dragHandleProps,
      isActive,
    }: DraggableRenderItemInfo<WorkspaceDesktopTabRowItem>) => {
      const layoutItem = layout.items[index] ?? null;
      const resolvedTabWidth = layoutItem?.width ?? 150;
      const showLabel = layoutItem?.showLabel ?? true;
      const showDropIndicatorBefore = activeDragTabId !== null && tabDropPreviewIndex === index;
      const showDropIndicatorAfter =
        activeDragTabId !== null &&
        tabDropPreviewIndex === tabs.length &&
        index === tabs.length - 1;

      return (
        <ResolvedDesktopTabChip
          key={`${item.tab.key}:${item.tab.kind}`}
          item={item}
          isFocused={isFocused}
          isDragging={isActive}
          index={index}
          tabCount={tabs.length}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          resolvedTabWidth={resolvedTabWidth}
          showLabel={showLabel}
          position={index + 1}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          labels={tabMenuLabels}
          dragHandleProps={dragHandleProps}
          showDropIndicatorBefore={showDropIndicatorBefore}
          showDropIndicatorAfter={showDropIndicatorAfter}
          onTabSlotLayout={handleTabSlotLayout}
        />
      );
    },
    [
      activeDragTabId,
      isFocused,
      layout.items,
      normalizedServerId,
      normalizedWorkspaceId,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      onNavigateTab,
      onReloadAgent,
      onRenameTab,
      setHoveredCloseTabKey,
      tabMenuLabels,
      tabDropPreviewIndex,
      tabs.length,
      handleTabSlotLayout,
    ],
  );

  const tabsScrollStyle = useMemo(
    () => [
      styles.tabsScroll,
      layout.requiresHorizontalScrollFallback
        ? styles.tabsScrollOverflow
        : styles.tabsScrollFitContent,
    ],
    [layout.requiresHorizontalScrollFallback],
  );

  const row = (
    <View
      style={styles.tabsContainer}
      testID="workspace-tabs-row"
      onLayout={handleTabsContainerLayout}
    >
      {focusModeEnabled ? (
        <View style={styles.exitFocusModeSlot} onLayout={handleExitFocusModeLayout}>
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger
              testID="workspace-exit-focus-mode"
              onPress={onExitFocusMode}
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.actions.exitFocusMode")}
              style={exitFocusModeButtonStyle}
            >
              <ThemedX size={14} uniProps={mutedColorMapping} />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <View style={styles.newTabTooltipRow}>
                <Text style={styles.newTabTooltipText}>
                  {t("workspace.tabs.actions.exitFocusMode")}
                </Text>
                {focusModeKeys ? (
                  <Shortcut chord={focusModeKeys} style={styles.newTabTooltipShortcut} />
                ) : null}
              </View>
            </TooltipContent>
          </Tooltip>
        </View>
      ) : null}
      <ScrollView
        ref={tabsScrollRef}
        horizontal
        scrollEnabled={layout.requiresHorizontalScrollFallback}
        onLayout={handleTabsScrollLayout}
        onScroll={handleTabsScroll}
        scrollEventThrottle={16}
        testID="workspace-tabs-scroll"
        style={tabsScrollStyle}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        <SortableInlineList
          data={tabs}
          keyExtractor={tabKeyExtractor}
          useDragHandle
          disabled={!externalDndContext && tabs.length < 2}
          onDragEnd={handleDragEnd}
          externalDndContext={externalDndContext}
          activeId={activeDragTabId}
          getItemData={getTabDragData}
          renderItem={renderTab}
        />
        <WorkspaceInlineAddTabButton
          shortcutKeys={newTabKeys}
          onCreateAgentTab={handleCreateAgentTab}
          onLayout={handleInlineAddButtonLayout}
        />
      </ScrollView>
      <View style={styles.tabsActions} onLayout={handleTabsActionsLayout}>
        <WorkspaceTabRowExtras
          onCreateAgentTab={handleCreateAgentTab}
          onCreateTerminal={handleCreateTerminal}
          onCreateBrowser={handleCreateBrowser}
          onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
          onEditProfiles={handleEditProfiles}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          showCreateBrowserTab={showCreateBrowserTab}
          terminalDisabled={terminalDisabled}
        />
        {showPaneSplitActions ? (
          <>
            <TabRowWordButton
              testID="workspace-tabs-split-right"
              word={TAB_ROW_WORDS.vsplit}
              onPress={onSplitRight}
              label={t("workspace.tabs.actions.splitRight")}
              shortcutKeys={splitRightKeys}
            />
            <TabRowWordButton
              testID="workspace-tabs-split-down"
              word={TAB_ROW_WORDS.hsplit}
              onPress={onSplitDown}
              label={t("workspace.tabs.actions.splitDown")}
              shortcutKeys={splitDownKeys}
            />
          </>
        ) : null}
      </View>
    </View>
  );

  return <RenderProfile id="WorkspaceDesktopTabsRow">{row}</RenderProfile>;
}
function ResolvedDesktopTabChip({
  item,
  isFocused,
  isDragging,
  index,
  tabCount,
  normalizedServerId,
  normalizedWorkspaceId,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  resolvedTabWidth,
  showLabel,
  position,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  labels,
  dragHandleProps,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
  onTabSlotLayout,
}: {
  item: WorkspaceDesktopTabRowItem;
  isFocused: boolean;
  isDragging: boolean;
  index: number;
  tabCount: number;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  resolvedTabWidth: number;
  showLabel: boolean;
  position: number;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  labels: WorkspaceTabMenuLabels;
  dragHandleProps: DraggableListDragHandleProps | undefined;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
  onTabSlotLayout: (tabKey: string, width: number) => void;
}) {
  const { t } = useTranslation();
  const tabKey = item.tab.key;
  const handleSlotLayout = useCallback(
    (event: LayoutChangeEvent) => onTabSlotLayout(tabKey, event.nativeEvent.layout.width),
    [onTabSlotLayout, tabKey],
  );
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onCopyTerminalId,
        onCopyFilePath,
        onReloadAgent,
        onRenameTab,
        onCloseTab,
        onCloseTabsToLeft,
        onCloseTabsToRight,
        onCloseOtherTabs,
        labels,
      }),
    [
      index,
      item.tab,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      labels,
      onReloadAgent,
      onRenameTab,
      tabCount,
    ],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={item.tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const tooltipLabel =
          presentation.titleState === "loading"
            ? t("workspace.tabs.loadingAgentTitle")
            : presentation.tooltip;

        return (
          <View style={styles.tabSlot} onLayout={handleSlotLayout}>
            {showDropIndicatorBefore ? (
              <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
            ) : null}
            <TabChip
              tab={item.tab}
              isActive={item.isActive}
              isDragging={isDragging}
              isFocused={isFocused}
              resolvedTabWidth={resolvedTabWidth}
              showLabel={showLabel}
              position={position}
              isCloseHovered={item.isCloseHovered}
              isClosingTab={item.isClosingTab}
              presentation={presentation}
              tooltipLabel={tooltipLabel}
              resolvedTab={resolvedTab}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              onNavigateTab={onNavigateTab}
              onCloseTab={onCloseTab}
              dragHandleProps={dragHandleProps}
            />
            {showDropIndicatorAfter ? (
              <View style={[styles.tabDropIndicator, styles.tabDropIndicatorAfter]} />
            ) : null}
          </View>
        );
      }}
    </WorkspaceTabPresentationResolver>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  tabsScroll: {
    minWidth: 0,
  },
  tabsScrollFitContent: {
    flex: 1,
  },
  tabsScrollOverflow: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
  },
  exitFocusModeSlot: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  inlineAddButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  // Daseo delta 112: a tab is a line of text the full height of the bar. Reverse video marks the
  // active tab; corners stay square (delta 55).
  tab: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    paddingHorizontal: TAB_HORIZONTAL_PADDING,
    flexDirection: "row",
    alignItems: "center",
    gap: TAB_CLOSE_SLOT_GAP,
    userSelect: "none",
  },
  tabActive: {
    backgroundColor: theme.colors.accent,
  },
  tabActiveUnfocused: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabSlot: {
    position: "relative",
    overflow: "visible",
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: TAB_HANDLE_GAP,
    flexShrink: 1,
    minWidth: 0,
    userSelect: "none",
  },
  tabIndex: {
    flexShrink: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  tabIndexReversed: {
    flexShrink: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.accentForeground,
  },
  tabDropIndicator: {
    position: "absolute",
    top: theme.spacing[2],
    bottom: theme.spacing[2],
    width: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  tabDropIndicatorBefore: {
    left: -3,
  },
  tabDropIndicatorAfter: {
    right: -3,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  tabLabelReversed: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    userSelect: "none",
  },
  tabLabelSkeleton: {
    width: 96,
    maxWidth: "100%",
    flexShrink: 1,
    minWidth: 0,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.9,
  },
  tabLabelSkeletonWithCloseButton: {
    width: LOADING_TAB_LABEL_SKELETON_WIDTH,
  },
  tabCloseButton: {
    width: TAB_CLOSE_SLOT_SIZE,
    height: TAB_CLOSE_SLOT_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonInert: {
    width: TAB_CLOSE_SLOT_SIZE,
    height: TAB_CLOSE_SLOT_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },
  tabCloseGlyph: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: TAB_CLOSE_SLOT_SIZE,
    color: theme.colors.foregroundMuted,
  },
  tabCloseGlyphHovered: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: TAB_CLOSE_SLOT_SIZE,
    color: theme.colors.foreground,
  },
  tabCloseGlyphReversed: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: TAB_CLOSE_SLOT_SIZE,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.accentForeground,
  },
  tabCloseGlyphHidden: {
    opacity: 0,
  },
  tabModifiedDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  tabModifiedDotReversed: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentForeground,
  },
  // The right-side words share the composer hint line's type (HintWord); this is only their box.
  wordButton: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  inlineAddActionButton: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    minWidth: DEFAULT_INLINE_ADD_BUTTON_RESERVED_WIDTH,
    paddingHorizontal: TAB_HORIZONTAL_PADDING,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabGlyph: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  newTabGlyphActive: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  exitFocusModeButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {},
  tooltipAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  terminalProfileIconWrapper: {
    width: 14,
    height: 14,
  },
}));
