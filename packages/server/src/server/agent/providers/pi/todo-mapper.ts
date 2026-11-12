import { z } from "zod";
import type { AgentTaskItem, AgentTimelineItem } from "../../agent-sdk-types.js";

type TodoTimelineItem = Extract<AgentTimelineItem, { type: "todo" }>;

// rpiv-todo registers its tool as `todo`; Claude through the Pi bridge sees it as
// `mcp__custom-tools__todo`, and either name may reach the session.
const PI_TODO_TOOL_NAMES = new Set(["todo", "mcp__custom-tools__todo"]);

// `list` and `get` read the list without changing it.
const READ_ONLY_ACTIONS = new Set(["list", "get"]);

const RpivTaskSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    subject: z.string(),
    status: z.string(),
    activeForm: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// rpiv-todo's `buildToolResult` details: the whole list after the call, on every result.
const RpivTodoDetailsSchema = z
  .object({
    action: z.string().optional(),
    tasks: z.array(z.unknown()),
    error: z.string().optional(),
  })
  .passthrough();

/** The `details` of a live `tool_execution_end` result (`{ content, details }`). */
export function readPiResultDetails(result: unknown): unknown {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? Reflect.get(result, "details")
    : undefined;
}

export function isPiTodoToolName(toolName: string): boolean {
  return PI_TODO_TOOL_NAMES.has(toolName);
}

/**
 * The task list an rpiv-todo call left behind, from the `details` of its result.
 * Null for a failed call, a read-only action, or a result that is not rpiv-todo's:
 * those leave the task list as it was.
 */
export function mapPiTodoToolResult(input: {
  toolName: string;
  details: unknown;
  isError: boolean;
}): TodoTimelineItem | null {
  if (input.isError || !isPiTodoToolName(input.toolName)) {
    return null;
  }
  const details = RpivTodoDetailsSchema.safeParse(input.details);
  if (!details.success || details.data.error !== undefined) {
    return null;
  }
  if (details.data.action && READ_ONLY_ACTIONS.has(details.data.action)) {
    return null;
  }
  const items: AgentTaskItem[] = [];
  for (const value of details.data.tasks) {
    const task = RpivTaskSchema.safeParse(value);
    if (!task.success) continue;
    const item = toTaskItem(task.data);
    if (item) items.push(item);
  }
  return { type: "todo", items };
}

/** Drops a todo snapshot equal to the previous one, so `no change` updates add no row. */
export class PiTodoSnapshotTracker {
  private last: string | null = null;

  accept(item: TodoTimelineItem): boolean {
    const key = JSON.stringify(item.items);
    if (key === this.last) {
      return false;
    }
    this.last = key;
    return true;
  }
}

function toTaskItem(task: z.infer<typeof RpivTaskSchema>): AgentTaskItem | null {
  const text = task.subject.trim();
  if (!text) {
    return null;
  }
  const metadata = task.metadata ?? {};
  const note = readLine(metadata.note);
  const activeForm = readLine(task.activeForm);
  const base = {
    id: String(task.id),
    text,
    ...(activeForm ? { activeForm } : {}),
  };
  if (task.status === "deleted") {
    return { ...base, status: "pending", completed: false, state: "deleted", ...noteField(note) };
  }
  if (task.status === "completed") {
    return { ...base, status: "completed", completed: true, ...noteField(note) };
  }
  if (task.status === "in_progress") {
    return { ...base, status: "in_progress", completed: false, ...noteField(note) };
  }
  // Only a pending task can be held or wait for a decision; other values read as plain pending.
  const state = metadata.state === "hold" || metadata.state === "decision" ? metadata.state : null;
  return {
    ...base,
    status: "pending",
    completed: false,
    ...(state ? { state } : {}),
    ...noteField(note),
  };
}

function noteField(note: string | undefined): { note?: string } {
  return note ? { note } : {};
}

function readLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 0 ? line : undefined;
}
