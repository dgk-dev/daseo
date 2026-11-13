import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { TodoEntry } from "@/types/stream";
import { resolveMaxTaskListHeight } from "./list-height";
import { formatTaskBoardLabel, resolveTaskRowState, summarizeTasks } from "./summary";

// The wave 1 acceptance list: 10 tasks, 3 done, 2 waiting on a decision, 2 held, 1 dropped.
const board: TodoEntry[] = [
  { id: "1", text: "Protocol", status: "completed", completed: true },
  { id: "2", text: "Mapping", status: "completed", completed: true },
  {
    id: "3",
    text: "Board UI",
    status: "in_progress",
    activeForm: "Building the board",
    completed: false,
  },
  {
    id: "4",
    text: "Pick a model",
    status: "pending",
    completed: false,
    state: "decision",
    note: "Opus or Sonnet",
  },
  { id: "5", text: "Rename", status: "pending", completed: false, state: "decision" },
  {
    id: "6",
    text: "Wiki",
    status: "pending",
    completed: false,
    state: "hold",
    note: "after the release",
  },
  {
    id: "7",
    text: "Metrics",
    status: "pending",
    completed: false,
    state: "hold",
    note: "needs a week of data",
  },
  {
    id: "8",
    text: "Old idea",
    status: "pending",
    completed: false,
    state: "deleted",
    note: "covered by #3",
  },
  { id: "9", text: "Release", status: "pending", completed: false },
  { id: "10", text: "Docs", status: "completed", completed: true },
];

describe("task board summary (Daseo delta 95)", () => {
  it("counts what is done, waiting, and held, and leaves dropped tasks out of the count", () => {
    const summary = summarizeTasks(board);
    expect({
      completed: summary.completed,
      total: summary.total,
      decision: summary.decision,
      hold: summary.hold,
      current: summary.current,
      listed: summary.listed.map((task) => task.id),
      dropped: summary.dropped.map((task) => task.id),
    }).toEqual({
      completed: 3,
      total: 9,
      decision: 2,
      hold: 2,
      current: { text: "Building the board", running: true },
      listed: ["1", "2", "3", "4", "5", "6", "7", "9", "10"],
      dropped: ["8"],
    });
  });

  it("writes the status line in Korean and English", () => {
    const summary = summarizeTasks(board);
    expect(formatTaskBoardLabel(summary, i18n.getFixedT("ko"))).toBe(
      "작업 3/9개 · 결정 대기 2 · 보류 2 · 지금: Building the board",
    );
    expect(formatTaskBoardLabel(summary, i18n.getFixedT("en"))).toBe(
      "3/9 tasks · 2 awaiting decision · 2 on hold · Now: Building the board",
    );
  });

  it("leaves out the current task in the task sidebar, whose list shows it (delta 101)", () => {
    const summary = summarizeTasks(board);
    expect(formatTaskBoardLabel(summary, i18n.getFixedT("ko"), { withCurrent: false })).toBe(
      "작업 3/9개 · 결정 대기 2 · 보류 2",
    );
  });

  it("keeps only the progress in the task sidebar, whose sections count the rest", () => {
    const summary = summarizeTasks(board);
    const sidebar = { withCurrent: false, withStateCounts: false };
    expect(formatTaskBoardLabel(summary, i18n.getFixedT("ko"), sidebar)).toBe("작업 3/9개");
    expect(formatTaskBoardLabel(summary, i18n.getFixedT("en"), sidebar)).toBe("3/9 tasks");
  });

  it("shows the next ordinary task, never a held one, when nothing runs", () => {
    const tasks: TodoEntry[] = [
      { id: "1", text: "Wiki", status: "pending", completed: false, state: "hold" },
      { id: "2", text: "Release", status: "pending", completed: false },
    ];
    expect(formatTaskBoardLabel(summarizeTasks(tasks), i18n.getFixedT("en"))).toBe(
      "0/2 tasks · 1 on hold · Release",
    );
  });

  it("reads a Claude Code or Codex list, which has no states, as before", () => {
    const tasks: TodoEntry[] = [
      { text: "Inspect", status: "completed", completed: true },
      { text: "Verify", status: "pending", completed: false },
    ];
    expect(formatTaskBoardLabel(summarizeTasks(tasks), i18n.getFixedT("en"))).toBe(
      "1/2 tasks · Verify",
    );
  });

  it("places each task by its state", () => {
    expect(board.map((task) => resolveTaskRowState(task))).toEqual([
      "completed",
      "completed",
      "running",
      "decision",
      "decision",
      "hold",
      "hold",
      "deleted",
      "pending",
      "completed",
    ]);
  });

  it("keeps the expanded list inside the room above the keyboard", () => {
    // Fold 7 inner screen with the keyboard up, then without it, then a desktop window.
    expect(resolveMaxTaskListHeight(712, 280)).toBe(129);
    expect(resolveMaxTaskListHeight(712, 0)).toBe(213);
    expect(resolveMaxTaskListHeight(300, 280)).toBe(120);
    expect(resolveMaxTaskListHeight(1000)).toBe(300);
  });
});
