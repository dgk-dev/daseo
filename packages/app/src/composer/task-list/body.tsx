import { memo, useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { TaskListRow } from "@/components/task-list-row";
import { useSessionStore } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import { formatTaskBoardLabel, summarizeTasks, type TaskBoardSummary } from "./summary";

/** The viewed agent's task list, or undefined when it has none (Daseo delta 95). */
export function useAgentTasks(serverId: string, agentId: string | null): TodoEntry[] | undefined {
  return useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentTasks.get(agentId) : undefined,
  );
}

/** The board's summary and its status line, shared by the composer board and the task sidebar. */
export function useTaskBoard(
  tasks: readonly TodoEntry[],
  options: { withCurrent?: boolean } = {},
): {
  summary: TaskBoardSummary;
  label: string;
} {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeTasks(tasks), [tasks]);
  return { summary, label: formatTaskBoardLabel(summary, t, options) };
}

/** Whether the dropped group is open. Owned by the surface so it survives the board collapsing. */
export function useDroppedGroupToggle(): {
  droppedExpanded: boolean;
  toggleDropped: () => void;
} {
  const [droppedExpanded, setDroppedExpanded] = useState(false);
  const toggleDropped = useCallback(() => setDroppedExpanded((current) => !current), []);
  return { droppedExpanded, toggleDropped };
}

/**
 * The task rows in the agent's order, then the dropped tasks dimmed in their own collapsed group.
 * One source for the composer board (compact layouts) and the right sidebar (wide layouts,
 * Daseo delta 101).
 */
export const TaskListBody = memo(function TaskListBody({
  summary,
  droppedExpanded,
  onToggleDropped,
}: {
  summary: TaskBoardSummary;
  droppedExpanded: boolean;
  onToggleDropped: () => void;
}) {
  const { t } = useTranslation();
  const droppedAccessibilityState = useMemo(
    () => ({ expanded: droppedExpanded }),
    [droppedExpanded],
  );
  const droppedLabel = t("message.todo.dropped", {
    count: summary.dropped.length,
  });

  return (
    <>
      <View style={styles.list}>
        {summary.listed.map((task, index) => (
          <TaskListRow key={task.id ?? `${index}:${task.text}`} task={task} />
        ))}
      </View>
      {summary.dropped.length > 0 ? (
        <View style={styles.dropped}>
          <Button
            variant="ghost"
            size="xs"
            onPress={onToggleDropped}
            accessibilityLabel={droppedLabel}
            accessibilityState={droppedAccessibilityState}
            leftIcon={droppedExpanded ? ChevronDown : ChevronRight}
            style={styles.droppedHeader}
            textStyle={styles.droppedText}
          >
            {droppedLabel}
          </Button>
          {droppedExpanded ? (
            <View style={styles.droppedList}>
              {summary.dropped.map((task, index) => (
                <TaskListRow key={task.id ?? `${index}:${task.text}`} task={task} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  dropped: {
    paddingBottom: theme.spacing[1],
  },
  droppedHeader: {
    width: "100%",
    justifyContent: "flex-start",
    borderRadius: 0,
    paddingHorizontal: theme.spacing[3],
  },
  droppedText: {
    color: theme.colors.foregroundExtraMuted,
  },
  droppedList: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[1],
  },
}));
