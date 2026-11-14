import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Check, CircleAlert } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { getPanelRegistration } from "@/panels/panel-registry";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_FRAME_SIZE, getStatusRingOffset } from "@/components/status-ring/geometry";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import type { Theme } from "@/styles/theme";
import { usePanelInstanceAttributes } from "@/panels/panel-instance-attributes";

export interface WorkspaceTabPresentation {
  key: string;
  kind: WorkspaceTabDescriptor["kind"];
  label: string;
  subtitle: string;
  tooltip: string;
  modified: boolean;
  titleState: "ready" | "loading";
  icon: React.ComponentType<{ size: number; color: string }>;
  statusBucket: SidebarStateBucket | null;
}

const DEFAULT_STATUS_DOT_OFFSET = -2;
const STATUS_ALERT_OFFSET = -3;

interface WorkspaceTabPresentationResolverProps {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  children: (presentation: WorkspaceTabPresentation) => ReactNode;
}

type WorkspaceTabPresentationResolverInnerProps = WorkspaceTabPresentationResolverProps & {
  registration: NonNullable<ReturnType<typeof getPanelRegistration>>;
};

export function WorkspaceTabPresentationResolver({
  tab,
  serverId,
  workspaceId,
  children,
}: WorkspaceTabPresentationResolverProps): ReactElement {
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.kind);
  invariant(registration, `No panel registration for kind: ${tab.kind}`);

  return (
    <WorkspaceTabPresentationResolverInner
      key={`${tab.key}:${tab.kind}`}
      registration={registration}
      tab={tab}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {children}
    </WorkspaceTabPresentationResolverInner>
  );
}

function WorkspaceTabPresentationResolverInner({
  registration,
  tab,
  serverId,
  workspaceId,
  children,
}: WorkspaceTabPresentationResolverInnerProps): ReactElement {
  const descriptor = registration.useDescriptor(tab.target as never, {
    serverId,
    workspaceId,
    tabId: tab.tabId,
  });
  const attributes = usePanelInstanceAttributes({ serverId, workspaceId, tabId: tab.tabId });

  const presentation = useMemo(
    () => ({
      key: tab.key,
      kind: tab.kind,
      label: descriptor.label,
      subtitle: descriptor.subtitle,
      tooltip: descriptor.tooltip,
      modified: attributes.modified,
      titleState: descriptor.titleState,
      icon: descriptor.icon,
      statusBucket: descriptor.statusBucket,
    }),
    [
      descriptor.icon,
      descriptor.label,
      descriptor.tooltip,
      descriptor.statusBucket,
      descriptor.subtitle,
      descriptor.titleState,
      tab.key,
      tab.kind,
      attributes.modified,
    ],
  );

  return <>{children(presentation)}</>;
}

interface WorkspaceTabIconProps {
  presentation: WorkspaceTabPresentation;
  active?: boolean;
  size?: number;
  statusDotBorderColor?: string;
  /**
   * The surface this icon is sitting on, so the running ring can knock out of it. This icon is
   * shared by the desktop tab strip, the tab switcher trigger, the split drag chip and the
   * subagents track, which are on different surfaces and some of which change surface on hover —
   * it cannot work the colour out for itself.
   */
  backdrop: SurfaceBackdrop;
}

const ThemedCheckIcon = withUnistyles(Check);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const needsInputAlertMapping = (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});

export function WorkspaceTabIcon({
  presentation,
  active = false,
  size = 14,
  statusDotBorderColor,
  backdrop,
}: WorkspaceTabIconProps): ReactElement {
  const iconColor = active ? styles.iconActive.color : styles.iconInactive.color;
  const bucket = presentation.statusBucket;
  const isRunning = bucket === "running";
  let statusDotColor: string | undefined;
  if (bucket === "failed") statusDotColor = styles.statusDotFailed.color;
  else if (bucket === "attention") statusDotColor = styles.statusDotAttention.color;
  const showNeedsInputAlert = bucket === "needs_input";
  const Icon = presentation.icon;
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );
  const statusDotStyle = useMemo(
    () => [
      styles.statusDot,
      {
        backgroundColor: statusDotColor,
        borderColor: statusDotBorderColor ?? styles.statusDotBorderDefault.borderColor,
      },
    ],
    [statusDotColor, statusDotBorderColor],
  );

  return (
    <View style={agentIconWrapperStyle}>
      <Icon size={size} color={iconColor} />
      {isRunning ? (
        <View
          style={styles.statusRing}
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
        >
          <StatusRing backdrop={backdrop} />
        </View>
      ) : null}
      {statusDotColor ? <View style={statusDotStyle} /> : null}
      {showNeedsInputAlert ? (
        <View style={styles.statusAlertOverlay}>
          <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputAlertMapping} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * A tab's place in its pane, printed in front of its title the way tmux numbers its windows:
 * `1:`, `2:`. One-based. Machine information, so it is set in the mono face.
 */
export function formatWorkspaceTabIndex(position: number): string {
  return `${position}:`;
}

// What an untitled tab shows as its title (an agent before its first title, a terminal with no
// cwd label): the same lowercase command vocabulary as the tab row's words, English in every
// locale. Delta 112: a tab is never just its index because the title came back empty.
const WORKSPACE_TAB_KIND_WORDS: Record<WorkspaceTabDescriptor["kind"], string> = {
  draft: "agent",
  agent: "agent",
  provider_subagent: "agent",
  terminal: "term",
  browser: "web",
  file: "file",
  working_diff: "diff",
  commit_diff: "diff",
  setup: "setup",
};

/** The title a tab shows: its label, or its kind word when the label is empty. */
export function resolveWorkspaceTabTitle(
  presentation: Pick<WorkspaceTabPresentation, "label" | "kind">,
): string {
  return presentation.label.trim() || WORKSPACE_TAB_KIND_WORDS[presentation.kind];
}

interface WorkspaceTabStatusMarkProps {
  presentation: WorkspaceTabPresentation;
  /**
   * The surface the mark knocks out of. Null where it sits on its own flat background (an idle
   * tab, a switcher row). A tab drawn in reverse video passes the bar's surface so the mark stays
   * a dark hole in the accent fill: the running ring is the accent colour in the Daseo theme and
   * would vanish on the accent otherwise.
   */
  backdrop: SurfaceBackdrop | null;
}

/**
 * The agent's state in front of a tab title (Daseo delta 112): the running ring, the failed or
 * attention dot, or the needs-input alert. Renders nothing for an idle or finished tab, so the
 * title starts right after the index. Tabs carry no per-kind icon any more; the subagents track
 * still draws `WorkspaceTabIcon`.
 */
export function WorkspaceTabStatusMark({
  presentation,
  backdrop,
}: WorkspaceTabStatusMarkProps): ReactElement | null {
  const bucket = presentation.statusBucket;
  const dotStyle = useMemo(() => {
    const knockout = backdrop ? styles.statusMarkDotKnockout : null;
    if (bucket === "failed") return [styles.statusMarkDot, styles.statusMarkDotFailed, knockout];
    if (bucket === "attention") {
      return [styles.statusMarkDot, styles.statusMarkDotAttention, knockout];
    }
    return null;
  }, [backdrop, bucket]);

  if (bucket === "running") {
    return (
      <View
        style={styles.statusMark}
        accessibilityRole="progressbar"
        accessibilityLabel="Agent running"
        testID="workspace-tab-status-running"
      >
        <StatusRing backdrop={backdrop} />
      </View>
    );
  }
  if (bucket === "needs_input") {
    return (
      <View style={styles.statusMark} testID="workspace-tab-status-needs-input">
        <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputAlertMapping} />
      </View>
    );
  }
  if (dotStyle) {
    return (
      <View style={styles.statusMark} testID={`workspace-tab-status-${bucket}`}>
        <View style={dotStyle} />
      </View>
    );
  }
  return null;
}

interface WorkspaceTabOptionRowProps {
  presentation: WorkspaceTabPresentation;
  /** One-based place of the tab in the switcher list. */
  position: number;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  trailingAccessory?: ReactNode;
}

export function WorkspaceTabOptionRow({
  presentation,
  position,
  selected,
  active,
  onPress,
  trailingAccessory,
}: WorkspaceTabOptionRowProps): ReactElement {
  const { t } = useTranslation();
  const isOptionActive = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
      Boolean(hovered) || pressed || active,
    [active],
  );
  const pressableStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.optionMainPressable,
      isOptionActive(state) && styles.optionRowActive,
    ],
    [isOptionActive],
  );
  const optionRowStyle = useMemo(
    () => [styles.optionRow, active && styles.optionRowActive],
    [active],
  );
  return (
    <View style={optionRowStyle}>
      <Pressable onPress={onPress} style={pressableStyle}>
        <Text style={styles.optionIndex} selectable={false} dataSet={CODE_SURFACE_DATASET}>
          {formatWorkspaceTabIndex(position)}
        </Text>
        <WorkspaceTabStatusMark presentation={presentation} backdrop={null} />
        <View style={styles.optionContent}>
          <Text numberOfLines={1} style={styles.optionLabel}>
            {presentation.titleState === "loading"
              ? t("workspace.tabs.loading")
              : resolveWorkspaceTabTitle(presentation)}
          </Text>
        </View>
      </Pressable>
      {presentation.modified ? (
        <View style={styles.optionModifiedDot} accessibilityLabel={t("workspace.tabs.modified")} />
      ) : null}
      {selected ? (
        <View style={styles.optionTrailingSlot}>
          <ThemedCheckIcon size={16} uniProps={mutedColorMapping} />
        </View>
      ) : null}
      {trailingAccessory ? (
        <View style={styles.optionTrailingAccessorySlot}>{trailingAccessory}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  statusRing: {
    position: "absolute",
    right: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
    bottom: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
  },
  statusDotBorderDefault: {
    borderColor: theme.colors.surface0,
  },
  statusAlertOverlay: {
    position: "absolute",
    right: STATUS_ALERT_OFFSET,
    bottom: STATUS_ALERT_OFFSET,
  },
  statusDotFailed: {
    color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusDotRunning: {
    color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  },
  statusDotAttention: {
    color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  iconActive: {
    color: theme.colors.foreground,
  },
  iconInactive: {
    color: theme.colors.foregroundMuted,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: 0,
    marginHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
  optionMainPressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  optionRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  optionIndex: {
    flexShrink: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  statusMark: {
    width: STATUS_RING_FRAME_SIZE,
    height: STATUS_RING_FRAME_SIZE,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusMarkDot: {
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  },
  statusMarkDotKnockout: {
    borderWidth: 1,
    borderColor: theme.colors.surface0,
  },
  statusMarkDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusMarkDotAttention: {
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  optionContent: {
    flex: 1,
    flexShrink: 1,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  optionTrailingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionModifiedDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  optionTrailingAccessorySlot: {
    alignItems: "center",
    justifyContent: "center",
  },
}));
