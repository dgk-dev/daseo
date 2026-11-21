import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { TaskListRow, TaskStateMarker } from "@/components/task-list-row";
import { SidebarSectionHeader } from "@/components/sidebar/pinned-section-header";
import { useSessionStore } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import {
  groupTasksBySection,
  isTaskSectionCollapsible,
  type TaskSection,
  type TaskSectionKey,
} from "./sections";
import { formatFoldedTaskSection, formatTaskSectionRule } from "./rail";
import {
  formatTaskBoardLabel,
  summarizeTasks,
  type TaskBoardLabelOptions,
  type TaskBoardSummary,
} from "./summary";

/** The viewed agent's task list, or undefined when it has none (Daseo delta 95). */
export function useAgentTasks(serverId: string, agentId: string | null): TodoEntry[] | undefined {
  return useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentTasks.get(agentId) : undefined,
  );
}

/** The board's summary and its status line, shared by the composer board and the task sidebar. */
export function useTaskBoard(
  tasks: readonly TodoEntry[],
  options: TaskBoardLabelOptions = {},
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
 * The composer board's rows (compact layouts and focus mode): the agent's order, then the dropped
 * tasks dimmed in their own collapsed group.
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

const SECTION_LABEL_KEYS = {
  running: "message.todo.section.running",
  decision: "message.todo.section.decision",
  pending: "message.todo.section.pending",
  hold: "message.todo.section.hold",
  completed: "message.todo.section.completed",
  deleted: "message.todo.section.deleted",
} as const satisfies Record<TaskSectionKey, string>;

const NO_EXPANDED_SECTIONS: ReadonlySet<TaskSectionKey> = new Set();

/**
 * The task rail's list (the right panel, Daseo delta 101): in progress, waiting on a decision, to
 * do, on hold, then done and dropped each folded into one line. Sections with no task are left
 * out, and done and dropped start folded on every mount.
 */
export const TaskSectionsBody = memo(function TaskSectionsBody({
  tasks,
}: {
  tasks: readonly TodoEntry[];
}) {
  const sections = useMemo(() => groupTasksBySection(tasks), [tasks]);
  const [expanded, setExpanded] = useState(NO_EXPANDED_SECTIONS);
  const toggleSection = useCallback((key: TaskSectionKey) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <View style={styles.sections}>
      {sections.map((section) => (
        <TaskSectionBlock
          key={section.key}
          section={section}
          collapsed={isTaskSectionCollapsible(section.key) && !expanded.has(section.key)}
          onToggle={toggleSection}
        />
      ))}
    </View>
  );
});

const TaskSectionBlock = memo(function TaskSectionBlock({
  section,
  collapsed,
  onToggle,
}: {
  section: TaskSection;
  collapsed: boolean;
  onToggle: (key: TaskSectionKey) => void;
}) {
  const { key, tasks } = section;
  const rows = collapsed ? null : (
    <View style={styles.sectionRows}>
      {tasks.map((task, index) => (
        <TaskListRow key={task.id ?? `${index}:${task.text}`} task={task} variant="sidebar" />
      ))}
    </View>
  );

  if (isTaskSectionCollapsible(key)) {
    return (
      <View testID={`task-sidebar-section-${key}`}>
        <FoldedSectionLine
          sectionKey={key}
          count={tasks.length}
          collapsed={collapsed}
          onToggle={onToggle}
        />
        {rows}
      </View>
    );
  }
  return (
    <View testID={`task-sidebar-section-${key}`}>
      <SidebarSectionHeader
        title={formatTaskSectionRule(key, tasks.length)}
        tone={key === "decision" ? "warning" : undefined}
        testID={`task-sidebar-section-${key}-header`}
      />
      {rows}
    </View>
  );
});

/** Done and dropped as one row of the list: `[x] 3 done ▸`. Pressing it opens the tasks below. */
function FoldedSectionLine({
  sectionKey,
  count,
  collapsed,
  onToggle,
}: {
  sectionKey: TaskSectionKey;
  count: number;
  collapsed: boolean;
  onToggle: (key: TaskSectionKey) => void;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(() => onToggle(sectionKey), [onToggle, sectionKey]);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  return (
    <Pressable
      onPress={toggle}
      style={styles.foldedLine}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      aria-expanded={!collapsed}
      accessibilityLabel={`${t(SECTION_LABEL_KEYS[sectionKey])} · ${count}`}
      testID={`task-sidebar-section-${sectionKey}-header`}
    >
      <TaskStateMarker state={sectionKey} variant="sidebar" />
      <Text style={styles.foldedText} numberOfLines={1} selectable={false}>
        {formatFoldedTaskSection(sectionKey, count, collapsed)}
      </Text>
    </Pressable>
  );
}

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
  // The header's own inset (spacing[2]) plus this one puts the rule, the markers, and the meter
  // above them on one rail.
  sections: {
    paddingHorizontal: theme.spacing[1],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[6],
  },
  sectionRows: {
    paddingHorizontal: theme.spacing[2],
  },
  // A row of the list (the rows' inset, gap, and line), so it reads as the list's last lines.
  foldedLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  foldedText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.4),
  },
}));
