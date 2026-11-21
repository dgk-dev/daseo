import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Unlink } from "lucide-react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { formatTerminalDuration } from "@/agent-stream/terminal-duration";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import type { SubagentRow } from "./select";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import { useTrackNow, useTrackSpinnerFrame } from "./track-clock";
import {
  buildSubagentRowPresentationData,
  buildTrackHeader,
  countFinishedSubagents,
  formatTrackHeaderText,
  resolveSubagentRowDurationMs,
  resolveSubagentRowState,
  SUBAGENT_SPINNER_FRAMES,
  SUBAGENT_STATE_GLYPH,
  SUBAGENT_STATE_WORD,
  summarizeSubagentTrack,
  type SubagentRowState,
  type SubagentTrackSummary,
  type TrackHeaderTone,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (id: string) => void;
}

const SUBAGENTS_LIST_MAX_HEIGHT = 200;

function headerToggleStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered || pressed ? styles.headerToggleActive : styles.headerToggle;
}

const HEADER_TONE_STYLE = {
  prompt: "headerPrompt",
  strong: "headerStrong",
  muted: "headerMuted",
  warning: "headerWarning",
  destructive: "headerDestructive",
} as const satisfies Record<TrackHeaderTone, string>;

const STATE_STYLE = {
  running: "stateRunning",
  waiting: "stateWaiting",
  done: "stateDone",
  error: "stateError",
  canceled: "stateMuted",
} as const satisfies Record<SubagentRowState, string>;

const GLYPH_STYLE = {
  running: "glyphRunning",
  waiting: "glyphWaiting",
  done: "glyphDone",
  error: "glyphError",
  canceled: "glyphMuted",
} as const satisfies Record<SubagentRowState, string>;

/**
 * `[+] Running 1/3  2min 13s` while anything runs, a muted `[+] 3 subagents · done` otherwise.
 * Only this text re-renders on the shared clock's second; the track around it does not.
 */
function TrackHeaderLabel({ summary }: { summary: SubagentTrackSummary }): ReactElement {
  const panelActive = useRetainedPanelActive();
  const startedAt = summary.oldestRunningStartedAt;
  const now = useTrackNow(panelActive && startedAt !== null);
  const elapsedLabel =
    startedAt === null ? null : formatTerminalDuration(Math.max(0, now - startedAt));
  const segments = buildTrackHeader(summary, elapsedLabel);
  return (
    <Text style={styles.headerLabel} numberOfLines={1} testID="subagents-track-header-label">
      {segments.map((segment) => (
        <Text key={segment.tone + segment.text} style={styles[HEADER_TONE_STYLE[segment.tone]]}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/** The leading cell: a braille spinner while the row runs, the state's glyph otherwise. */
function SubagentStateGlyph({ state }: { state: SubagentRowState }): ReactElement {
  const reduceMotion = useReducedMotion();
  const panelActive = useRetainedPanelActive();
  const animate = state === "running" && !reduceMotion && panelActive;
  const frame = useTrackSpinnerFrame(animate);
  const glyph = animate
    ? SUBAGENT_SPINNER_FRAMES[frame % SUBAGENT_SPINNER_FRAMES.length]
    : SUBAGENT_STATE_GLYPH[state];
  const text = (
    <Text
      style={styles[GLYPH_STYLE[state]]}
      selectable={false}
      // The cell (running) or the state word next to it carries the meaning.
      aria-hidden
      testID={`subagents-track-glyph-${state}`}
    >
      {glyph}
    </Text>
  );
  if (state === "running") {
    // The same role and name the row's loader had before the glyph replaced it.
    return (
      <View
        style={styles.glyphCell}
        accessibilityRole="progressbar"
        accessibilityLabel="Agent running"
      >
        {text}
      </View>
    );
  }
  return <View style={styles.glyphCell}>{text}</View>;
}

/** Live elapsed time while the row works, its total once it ended; nothing without real times. */
function SubagentRowTime({
  row,
  state,
}: {
  row: SubagentRow;
  state: SubagentRowState;
}): ReactElement | null {
  const panelActive = useRetainedPanelActive();
  const live = state === "running" || state === "waiting";
  const now = useTrackNow(live && panelActive);
  const durationMs = resolveSubagentRowDurationMs(row, now);
  if (durationMs === null) return null;
  return (
    <Text style={styles.rowTime} numberOfLines={1} testID={`subagents-track-time-${row.id}`}>
      {formatTerminalDuration(durationMs)}
    </Text>
  );
}

export function SubagentsTrack({
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = { kind: "idle" },
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );
  const headerAccessibilityState = useMemo(() => ({ expanded }), [expanded]);

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  if (rows.length === 0 && !isArchivingFinished && !isArchiveFinishedFailed) {
    return null;
  }

  const summary = summarizeSubagentTrack(rows);
  // The accessible name leaves the ticking time out so it is not re-announced every second.
  const headerLabel = formatTrackHeaderText(buildTrackHeader(summary, null));
  const finishedCount = countFinishedSubagents(rows);
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;

  return (
    <View style={styles.outer} testID="subagents-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              accessibilityState={headerAccessibilityState}
              testID="subagents-track-header"
              onPress={toggleExpanded}
              style={headerToggleStyle}
            >
              <TrackHeaderLabel summary={summary} />
            </Pressable>
            {showArchiveFinished && onArchiveFinished ? (
              <View style={styles.headerAction}>
                <SubagentActionButton
                  accessibilityLabel={t("subagents.archiveFinishedAction")}
                  testID="subagents-track-archive-finished"
                  tooltipLabel={t("subagents.archiveFinishedTooltip")}
                  icon="archive"
                  visible
                  disabled={isArchivingFinished}
                  onPress={onArchiveFinished}
                />
                {archiveFinishedStatus.kind === "archiving" ? (
                  <Text
                    style={styles.archiveFinishedStatus}
                    testID="subagents-track-archive-progress"
                  >
                    {archiveFinishedStatus.completedCount}/{archiveFinishedStatus.totalCount}
                  </Text>
                ) : null}
                {archiveFinishedStatus.kind === "failed" ? (
                  <Text
                    style={styles.archiveFinishedStatus}
                    testID="subagents-track-archive-failed"
                  >
                    {t("subagents.archiveFinishedRetry", {
                      failed: archiveFinishedStatus.failedCount,
                      total: archiveFinishedStatus.totalCount,
                    })}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {rows.map((row) => (
                <SubagentsTrackRow
                  key={row.id}
                  row={row}
                  onOpenSubagent={onOpenSubagent}
                  onOpenProviderSubagent={onOpenProviderSubagent}
                  onArchiveSubagent={onArchiveSubagent}
                  onDetachSubagent={onDetachSubagent}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

interface SubagentsTrackRowProps {
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
}

function SubagentsTrackRow({
  row,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const presentation = useMemo(() => buildSubagentRowPresentationData(row), [row]);
  const state = resolveSubagentRowState(row);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.id);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  const handleArchivePress = useCallback(() => {
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row.id]);
  const handleDetachPress = useCallback(() => {
    onDetachSubagent?.(row.id);
  }, [onDetachSubagent, row.id]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const actionsAlwaysVisible = isNative || isCompact;
  const actionsVisible = actionsAlwaysVisible || hovered;

  return (
    // Wrapper View handles hover so moving the pointer between the row and
    // the archive button doesn't drop the hover state — the same pattern
    // used by sidebar workspace rows.
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayLabel}
        testID={`subagents-track-row-${row.id}`}
        onPress={handlePress}
      >
        {({ pressed }) => (
          <View style={hovered || pressed ? styles.rowActive : styles.row}>
            <SubagentStateGlyph state={state} />
            <Text style={styles.rowLabel} numberOfLines={1}>
              {displayLabel}
            </Text>
            {presentation.subtitle ? (
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {presentation.subtitle}
              </Text>
            ) : null}
            <Text
              style={styles[STATE_STYLE[state]]}
              numberOfLines={1}
              testID={`subagents-track-state-${row.id}`}
            >
              {SUBAGENT_STATE_WORD[state]}
            </Text>
            <SubagentRowTime row={row} state={state} />
            {row.kind === "paseo" ? (
              <SubagentRowActions
                rowId={row.id}
                displayLabel={displayLabel}
                visible={actionsVisible}
                onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
                onArchivePress={handleArchivePress}
              />
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function SubagentRowActions({
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
          testID={`subagents-track-detach-${rowId}`}
          tooltipLabel={t("subagents.detachTooltip")}
          icon="detach"
          visible={visible}
          onPress={onDetachPress}
        />
      ) : null}
      <SubagentActionButton
        accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={t("subagents.archiveTooltip")}
        icon="archive"
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach";

function renderSubagentActionIcon(icon: SubagentActionIcon, isActive: boolean): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={14} uniProps={uniProps} />;
  }
  return <ThemedArchive size={14} uniProps={uniProps} />;
}

function SubagentActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  disabled = false,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: SubagentActionIcon;
  visible: boolean;
  disabled?: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible || disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          disabled={disabled}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => renderSubagentActionIcon(icon, hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
  },
  // Daseo delta 57: a status line over the prompt line (delta 53), not a tab tucked under a
  // composer box; no fill, sides, corners, or overlap with the composer. Delta 116: no top rule
  // either; the transcript, the track and the composer separate by spacing alone.
  surface: {
    alignSelf: "stretch",
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerToggleActive: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  headerAction: {
    paddingRight: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  archiveFinishedStatus: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  headerCollapsed: {},
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  // Sketch option C (docker compose): `[+] Running 1/3  2min 13s`, machine text in the mono font.
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  headerPrompt: {
    color: theme.colors.promptPath,
  },
  headerStrong: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.bold,
  },
  headerMuted: {
    color: theme.colors.foregroundMuted,
  },
  headerWarning: {
    color: theme.colors.statusWarning,
  },
  headerDestructive: {
    color: theme.colors.destructive,
  },
  scroll: {
    maxHeight: SUBAGENTS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // Keep provider context secondary and bounded so the task remains readable on compact screens.
  rowSubtitle: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "30%",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  // One monospace cell wide and fixed, so a spinner frame never shifts the label beside it.
  glyphCell: {
    width: Math.round(theme.fontSize.sm * 1.2),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  glyphRunning: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
  },
  glyphDone: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
  },
  glyphError: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  glyphWaiting: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
  },
  glyphMuted: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  stateRunning: {
    flexShrink: 0,
    // Eight cells, the longest word, so the words start on one column.
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 8),
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.accent,
  },
  stateDone: {
    flexShrink: 0,
    // Eight cells, the longest word, so the words start on one column.
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 8),
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  stateError: {
    flexShrink: 0,
    // Eight cells, the longest word, so the words start on one column.
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 8),
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  stateWaiting: {
    flexShrink: 0,
    // Eight cells, the longest word, so the words start on one column.
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 8),
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
  },
  stateMuted: {
    flexShrink: 0,
    // Eight cells, the longest word, so the words start on one column.
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 8),
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowTime: {
    flexShrink: 0,
    minWidth: Math.round(theme.fontSize.xs * 0.6 * 9),
    textAlign: "right",
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
