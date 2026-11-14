import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useKeyboardHeight } from "@/hooks/use-keyboard-height";
import type { TodoEntry } from "@/types/stream";
import { TaskListBody, useAgentTasks, useDroppedGroupToggle, useTaskBoard } from "./body";
import { resolveMaxTaskListHeight } from "./list-height";

export const AgentTaskList = memo(function AgentTaskList({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const tasks = useAgentTasks(serverId, agentId);
  if (!tasks?.length) return null;
  return <TaskListCard tasks={tasks} />;
});

const TaskListCard = memo(function TaskListCard({ tasks }: { tasks: TodoEntry[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { summary, label } = useTaskBoard(tasks);
  const { droppedExpanded, toggleDropped } = useDroppedGroupToggle();
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

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
              <TaskListBody
                summary={summary}
                droppedExpanded={droppedExpanded}
                onToggleDropped={toggleDropped}
              />
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
    () => ({ maxHeight: resolveMaxTaskListHeight(windowHeight, keyboardHeight) }),
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
  // Delta 116: no rule above it or between its line and its list; spacing separates them.
  card: {
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
}));
