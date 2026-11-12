import {
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleQuestionMark,
  CircleX,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { resolveTaskRowState, type TaskRowState } from "@/composer/task-list/summary";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCirclePause = withUnistyles(CirclePause);
const ThemedCircleQuestionMark = withUnistyles(CircleQuestionMark);
const ThemedCircleX = withUnistyles(CircleX);

const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const runningIcon = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
// A decision waits for the user, the same signal as an agent that needs them.
const decisionIcon = (theme: Theme) => ({ color: theme.colors.statusDotWarning });

function TaskStatusIcon({ state }: { state: TaskRowState }) {
  switch (state) {
    case "completed":
      return <ThemedCircleCheck size={16} uniProps={extraMutedIcon} />;
    case "running":
      return <ThemedCircleDot size={16} uniProps={runningIcon} />;
    case "decision":
      return <ThemedCircleQuestionMark size={16} uniProps={decisionIcon} />;
    case "hold":
      return <ThemedCirclePause size={16} uniProps={mutedIcon} />;
    case "deleted":
      return <ThemedCircleX size={16} uniProps={extraMutedIcon} />;
    case "pending":
      return <ThemedCircle size={16} uniProps={mutedIcon} />;
  }
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

export const TaskListRow = memo(function TaskListRow({ task }: { task: TodoEntry }) {
  const { t } = useTranslation();
  const state = resolveTaskRowState(task);
  const text = state === "running" && task.activeForm ? task.activeForm : task.text;
  const suffix = resolveTaskSuffix(state, task.note, t);

  return (
    <View style={styles.row} accessibilityLabel={suffix ? `${text}, ${suffix}` : text}>
      <TaskStatusIcon state={state} />
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
}));
