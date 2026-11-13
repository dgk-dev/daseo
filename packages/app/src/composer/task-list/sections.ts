import type { TodoEntry } from "@/types/stream";
import { resolveTaskRowState, type TaskRowState } from "./summary";

/** A section of the task sidebar is named after the row state of the tasks it holds. */
export type TaskSectionKey = TaskRowState;

export interface TaskSection {
  key: TaskSectionKey;
  /** The section's tasks, in the agent's order. */
  tasks: TodoEntry[];
}

/** In progress, waits on the owner, to do, held, then done and dropped (Daseo delta 101). */
export const TASK_SECTION_ORDER: readonly TaskSectionKey[] = [
  "running",
  "decision",
  "pending",
  "hold",
  "completed",
  "deleted",
];

/** Done and dropped tasks start folded away; the open work is what the sidebar is for. */
export function isTaskSectionCollapsible(key: TaskSectionKey): boolean {
  return key === "completed" || key === "deleted";
}

/**
 * The task sidebar's sections: each task under its row state, the agent's order kept inside a
 * section, and a section with no task left out. The compact board keeps the flat list.
 */
export function groupTasksBySection(tasks: readonly TodoEntry[]): TaskSection[] {
  const buckets = new Map<TaskSectionKey, TodoEntry[]>();
  for (const task of tasks) {
    const key = resolveTaskRowState(task);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }
  const sections: TaskSection[] = [];
  for (const key of TASK_SECTION_ORDER) {
    const sectionTasks = buckets.get(key);
    if (sectionTasks) sections.push({ key, tasks: sectionTasks });
  }
  return sections;
}
