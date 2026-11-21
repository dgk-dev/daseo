import type { TodoEntry } from "@/types/stream";
import type { TaskSectionKey } from "./sections";
import type { TaskRowState } from "./summary";

/**
 * The task rail: the right panel as a narrow column (240 by default, 200 at least). Its header is
 * a text meter, its rows are one line each and open in place, and its section rules carry short
 * fixed words, terminal chrome like `menu` and `run`, so they fit the narrowest rail.
 */

export const TASK_METER_CELLS = 9;

export interface TaskMeter {
  /** Filled cells, `|` each. */
  filled: string;
  /** Empty cells, `.` each. */
  empty: string;
  /** `done/total`, dropped tasks left out of both. */
  count: string;
}

/**
 * `tasks [|||......] 3/9`: the share of tasks done, in whole cells. Any progress shows at least
 * one cell and only a finished list fills the last one, so the ends never lie.
 */
export function resolveTaskMeter(
  progress: { completed: number; total: number },
  cells: number = TASK_METER_CELLS,
): TaskMeter {
  const total = Math.max(0, progress.total);
  const completed = Math.max(0, Math.min(total, progress.completed));
  let filled = total === 0 ? 0 : Math.round((completed / total) * cells);
  if (completed > 0) filled = Math.max(1, filled);
  if (completed < total) filled = Math.min(cells - 1, filled);
  return {
    filled: "|".repeat(filled),
    empty: ".".repeat(cells - filled),
    count: `${completed}/${total}`,
  };
}

/** One word per section, in the fixed English of the terminal chrome. */
export const TASK_SECTION_WORDS: Record<TaskSectionKey, string> = {
  running: "now",
  decision: "ask",
  pending: "todo",
  hold: "hold",
  completed: "done",
  deleted: "dropped",
};

/** An open section's rule: `── todo · 5 ──`. */
export function formatTaskSectionRule(key: TaskSectionKey, count: number): string {
  return `${TASK_SECTION_WORDS[key]} · ${count}`;
}

/** A foldable section's single line beside its marker: `3 done ▸`, `3 done ▾` when open. */
export function formatFoldedTaskSection(
  key: TaskSectionKey,
  count: number,
  collapsed: boolean,
): string {
  return `${count} ${TASK_SECTION_WORDS[key]} ${collapsed ? "▸" : "▾"}`;
}

export interface TaskRailRowLines {
  /** Null: the subject wraps freely (the row is open). */
  subjectLineLimit: 1 | null;
  /** What the task in progress is doing now, when that says more than its subject. */
  doingNow: string | null;
  /** The agent's note, shown only while the row is open. */
  note: string | null;
}

/**
 * What a rail row shows. Closed, it is the subject on one line, and the task in progress keeps its
 * "doing now" line. Open, the subject wraps and the note joins.
 */
export function resolveTaskRailRowLines(
  task: Pick<TodoEntry, "text" | "activeForm" | "note">,
  state: TaskRowState,
  expanded: boolean,
): TaskRailRowLines {
  const doingNow =
    state === "running" && task.activeForm && task.activeForm !== task.text
      ? task.activeForm
      : null;
  return {
    subjectLineLimit: expanded ? null : 1,
    doingNow,
    note: expanded && task.note ? task.note : null,
  };
}
