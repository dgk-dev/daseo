import type { TFunction } from "i18next";
import type { TodoEntry } from "@/types/stream";

export type TaskRowState = "completed" | "running" | "decision" | "hold" | "deleted" | "pending";

export interface TaskBoardSummary {
  /** Completed tasks, dropped ones left out. */
  completed: number;
  /** All tasks but the dropped ones. */
  total: number;
  decision: number;
  hold: number;
  /** The task in progress, else the next ordinary pending one. */
  current: { text: string; running: boolean } | null;
  /** Tasks shown in the list, in the agent's order. */
  listed: TodoEntry[];
  /** Dropped tasks, shown dimmed in their own collapsed group. */
  dropped: TodoEntry[];
}

/** One task's place on the board (Daseo delta 95). */
export function resolveTaskRowState(task: TodoEntry): TaskRowState {
  if (task.state === "deleted") return "deleted";
  if (task.completed || task.status === "completed") return "completed";
  if (task.status === "in_progress") return "running";
  if (task.state === "decision") return "decision";
  if (task.state === "hold") return "hold";
  return "pending";
}

export function summarizeTasks(tasks: readonly TodoEntry[]): TaskBoardSummary {
  const listed: TodoEntry[] = [];
  const dropped: TodoEntry[] = [];
  let completed = 0;
  let decision = 0;
  let hold = 0;
  let running: TodoEntry | undefined;
  let next: TodoEntry | undefined;
  for (const task of tasks) {
    const state = resolveTaskRowState(task);
    if (state === "deleted") {
      dropped.push(task);
      continue;
    }
    listed.push(task);
    if (state === "completed") completed += 1;
    else if (state === "decision") decision += 1;
    else if (state === "hold") hold += 1;
    else if (state === "running") running ??= task;
    else next ??= task;
  }
  return {
    completed,
    total: listed.length,
    decision,
    hold,
    current: resolveCurrentTask(running, next),
    listed,
    dropped,
  };
}

function resolveCurrentTask(
  running: TodoEntry | undefined,
  next: TodoEntry | undefined,
): TaskBoardSummary["current"] {
  if (running) return { text: running.activeForm || running.text, running: true };
  if (next) return { text: next.text, running: false };
  return null;
}

export interface TaskBoardLabelOptions {
  /** What runs now (`Now: …`); default on. */
  withCurrent?: boolean;
  /** The waiting and held counts; default on. */
  withStateCounts?: boolean;
}

/**
 * The status line: progress, what waits on the user, what is held, and what runs now. The task
 * sidebar (Daseo delta 101) keeps only the progress: its sections show the task in progress and
 * carry the waiting and held counts in their headers.
 */
export function formatTaskBoardLabel(
  summary: TaskBoardSummary,
  t: TFunction,
  options: TaskBoardLabelOptions = {},
): string {
  const parts = [
    t("message.todo.tasksProgress", { completed: summary.completed, total: summary.total }),
  ];
  if (options.withStateCounts !== false) {
    if (summary.decision > 0) {
      parts.push(t("message.todo.decisionCount", { count: summary.decision }));
    }
    if (summary.hold > 0) parts.push(t("message.todo.holdCount", { count: summary.hold }));
  }
  if (summary.current && options.withCurrent !== false) {
    parts.push(
      summary.current.running
        ? t("message.todo.now", { task: summary.current.text })
        : summary.current.text,
    );
  }
  return parts.join(" · ");
}
