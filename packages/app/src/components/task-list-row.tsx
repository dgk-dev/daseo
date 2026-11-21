import type { TFunction } from "i18next";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { resolveTaskRailRowLines } from "@/composer/task-list/rail";
import { resolveTaskRowState, type TaskRowState } from "@/composer/task-list/summary";
import type { TodoEntry } from "@/types/stream";

// Daseo delta 116: a task's state is a checkbox the way a terminal checklist prints one, in
// place of the circle icons. The colours keep their meaning: the task in progress in the
// running colour, a decision in the warning colour, closed tasks faint, the rest muted.
export const TASK_STATE_MARKERS: Record<TaskRowState, string> = {
  running: "[>]",
  decision: "[?]",
  pending: "[ ]",
  hold: "[=]",
  completed: "[x]",
  deleted: "[-]",
};

function resolveMarkerColorStyle(state: TaskRowState) {
  switch (state) {
    case "running":
      return styles.markerRunning;
    case "decision":
      return styles.markerDecision;
    case "completed":
    case "deleted":
      return styles.markerClosed;
    case "hold":
    case "pending":
      return styles.markerOpen;
  }
}

export function TaskStateMarker({
  state,
  variant,
}: {
  state: TaskRowState;
  variant: TaskListRowVariant;
}) {
  return (
    <Text
      style={[
        variant === "sidebar" ? styles.sidebarMarker : styles.marker,
        resolveMarkerColorStyle(state),
      ]}
      testID="task-state-marker"
      accessible={false}
      aria-hidden
      selectable={false}
    >
      {TASK_STATE_MARKERS[state]}
    </Text>
  );
}

// Daseo delta 95: a held or waiting task says so, and the agent's one-line note follows.
function resolveTaskSuffix(
  state: TaskRowState,
  note: string | undefined,
  t: TFunction,
): string | null {
  let label: string | null = null;
  if (state === "decision") label = t("message.todo.state.decision");
  if (state === "hold") label = t("message.todo.state.hold");
  if (label && note) return `${label}: ${note}`;
  return label ?? note ?? null;
}

export type TaskListRowVariant = "board" | "sidebar";

/**
 * One task. `board` is the composer board's one-line row (delta 95); `sidebar` is the task
 * rail's row at reading size: one line that opens in place when pressed, under a section that
 * already names the state (delta 101).
 */
export const TaskListRow = memo(function TaskListRow({
  task,
  variant = "board",
}: {
  task: TodoEntry;
  variant?: TaskListRowVariant;
}) {
  const { t } = useTranslation();
  const state = resolveTaskRowState(task);
  const suffix = resolveTaskSuffix(state, task.note, t);
  if (variant === "sidebar") return <SidebarTaskRow task={task} state={state} suffix={suffix} />;
  const text = state === "running" && task.activeForm ? task.activeForm : task.text;

  return (
    <View style={styles.row} accessibilityLabel={suffix ? `${text}, ${suffix}` : text}>
      <TaskStateMarker state={state} variant="board" />
      <Text
        numberOfLines={suffix ? 2 : 1}
        style={[
          styles.text,
          state === "running" && styles.runningText,
          state === "completed" && styles.completedText,
          state === "deleted" && styles.droppedText,
        ]}
      >
        {text}
        {suffix ? <Text style={styles.note}>{` · ${suffix}`}</Text> : null}
      </Text>
    </View>
  );
});

function SidebarTaskRow({
  task,
  state,
  suffix,
}: {
  task: TodoEntry;
  state: TaskRowState;
  suffix: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const lines = resolveTaskRailRowLines(task, state, expanded);
  const closed = state === "completed" || state === "deleted";
  const detailStyle = [styles.sidebarDetail, closed && styles.droppedText];
  const accessibilityLabel = [task.text, lines.doingNow, suffix].filter(Boolean).join(", ");
  const detailLineLimit = expanded ? undefined : 1;

  // The rail is narrow: a row is its subject on one line and opens in place to the whole subject,
  // what runs now, and the agent's note. The task in progress keeps its "doing now" line closed.
  return (
    <Pressable
      onPress={toggle}
      style={styles.sidebarRow}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      aria-expanded={expanded}
      accessibilityLabel={accessibilityLabel}
      testID="task-sidebar-row"
    >
      <TaskStateMarker state={state} variant="sidebar" />
      <View style={styles.sidebarContent}>
        <Text
          numberOfLines={lines.subjectLineLimit ?? undefined}
          style={[
            styles.sidebarText,
            state === "completed" && styles.completedText,
            state === "deleted" && styles.droppedText,
          ]}
        >
          {task.text}
        </Text>
        {lines.doingNow ? (
          <Text numberOfLines={detailLineLimit} style={detailStyle}>
            {lines.doingNow}
          </Text>
        ) : null}
        {lines.note ? <Text style={detailStyle}>{lines.note}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  runningText: {
    color: theme.colors.foreground,
  },
  completedText: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
  droppedText: {
    color: theme.colors.foregroundExtraMuted,
  },
  note: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "none",
  },
  sidebarRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  // The marker sets in the mono face at its row's text size and line height, so it sits on the
  // subject's first line however far the subject wraps.
  marker: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  sidebarMarker: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.4),
    flexShrink: 0,
  },
  markerRunning: {
    color: theme.colors.statusDotRunning,
  },
  // A decision waits for the user, the same signal as an agent that needs them.
  markerDecision: {
    color: theme.colors.statusDotWarning,
  },
  markerOpen: {
    color: theme.colors.foregroundMuted,
  },
  markerClosed: {
    color: theme.colors.foregroundExtraMuted,
  },
  sidebarContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  // The chat's prose size and line height (markdown body), the app's reading size.
  sidebarText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.4),
  },
  // The prose line height of its size (as the subject's), so a wrapped note keeps its leading.
  sidebarDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
}));
