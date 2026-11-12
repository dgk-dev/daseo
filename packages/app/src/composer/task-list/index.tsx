import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { TaskListRow } from "@/components/task-list-row";
import { useKeyboardHeight } from "@/hooks/use-keyboard-height";
import { useSessionStore } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import { resolveMaxTaskListHeight } from "./list-height";
import { formatTaskBoardLabel, summarizeTasks } from "./summary";

export const AgentTaskList = memo(function AgentTaskList({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const tasks = useSessionStore((state) => state.sessions[serverId]?.agentTasks.get(agentId));
  if (!tasks?.length) return null;
  return <TaskListCard tasks={tasks} />;
});

const TaskListCard = memo(function TaskListCard({ tasks }: { tasks: TodoEntry[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [droppedExpanded, setDroppedExpanded] = useState(false);
  const summary = useMemo(() => summarizeTasks(tasks), [tasks]);
  const label = formatTaskBoardLabel(summary, t);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const toggleDropped = useCallback(() => setDroppedExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const droppedAccessibilityState = useMemo(
    () => ({ expanded: droppedExpanded }),
    [droppedExpanded],
  );
  const droppedLabel = t("message.todo.dropped", { count: summary.dropped.length });

  return (
    <View style={styles.container} accessibilityLabel={t("message.todo.title")}>
      <View style={styles.track}>
        <View style={styles.card}>
          <Button
            variant="ghost"
            size="xs"
            onPress={toggle}
            accessibilityLabel={label}
            accessibilityState={accessibilityState}
            leftIcon={expanded ? ChevronDown : ChevronRight}
            style={styles.header}
            textStyle={styles.headerText}
          >
            {label}
          </Button>
          {expanded ? (
            <TaskListScroll>
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
                    onPress={toggleDropped}
                    accessibilityLabel={droppedLabel}
                    accessibilityState={droppedAccessibilityState}
                    leftIcon={droppedExpanded ? ChevronDown : ChevronRight}
                    style={styles.header}
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
            </TaskListScroll>
          ) : null}
        </View>
      </View>
    </View>
  );
});

// Daseo delta 95: a long list scrolls inside a cap so the prompt stays on screen.
function TaskListScroll({ children }: { children: ReactNode }) {
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  const scrollStyle = useMemo(
    () => [styles.scroll, { maxHeight: resolveMaxTaskListHeight(windowHeight, keyboardHeight) }],
    [windowHeight, keyboardHeight],
  );
  return (
    <ScrollView style={scrollStyle} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
  },
  // Daseo delta 57: a status line over the prompt line (delta 53), like the subagents track.
  card: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    overflow: "hidden",
  },
  header: {
    width: "100%",
    justifyContent: "flex-start",
    borderRadius: 0,
    paddingHorizontal: theme.spacing[3],
  },
  headerText: {
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  list: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  dropped: {
    paddingBottom: theme.spacing[1],
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
