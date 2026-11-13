import { describe, expect, it } from "vitest";
import type { TodoEntry } from "@/types/stream";
import { groupTasksBySection, isTaskSectionCollapsible } from "./sections";

// The board acceptance list (delta 95): 10 tasks covering every state, in the agent's order.
const board: TodoEntry[] = [
  { id: "1", text: "Protocol", status: "completed", completed: true },
  { id: "2", text: "Mapping", status: "completed", completed: true },
  { id: "3", text: "Board UI", status: "in_progress", activeForm: "Building", completed: false },
  { id: "4", text: "Pick a model", status: "pending", completed: false, state: "decision" },
  { id: "5", text: "Rename", status: "pending", completed: false, state: "decision" },
  { id: "6", text: "Wiki", status: "pending", completed: false, state: "hold" },
  { id: "7", text: "Metrics", status: "pending", completed: false, state: "hold" },
  { id: "8", text: "Old idea", status: "pending", completed: false, state: "deleted" },
  { id: "9", text: "Release", status: "pending", completed: false },
  { id: "10", text: "Docs", status: "completed", completed: true },
];

function sectionIds(tasks: readonly TodoEntry[]): [string, string[]][] {
  return groupTasksBySection(tasks).map((section) => [
    section.key,
    section.tasks.map((task) => task.id ?? task.text),
  ]);
}

describe("task sidebar sections (Daseo delta 101)", () => {
  it("puts every task in its section, in the fixed section order", () => {
    expect(sectionIds(board)).toEqual([
      ["running", ["3"]],
      ["decision", ["4", "5"]],
      ["pending", ["9"]],
      ["hold", ["6", "7"]],
      ["completed", ["1", "2", "10"]],
      ["deleted", ["8"]],
    ]);
  });

  it("keeps the agent's order inside a section", () => {
    const tasks: TodoEntry[] = [
      { id: "3", text: "Third", completed: false },
      { id: "1", text: "First", completed: false },
      { id: "2", text: "Second", completed: false },
    ];
    expect(sectionIds(tasks)).toEqual([["pending", ["3", "1", "2"]]]);
  });

  it("leaves out sections with no task", () => {
    const tasks: TodoEntry[] = [
      { id: "1", text: "Wiki", status: "pending", completed: false, state: "hold" },
      { id: "2", text: "Docs", status: "completed", completed: true },
    ];
    expect(sectionIds(tasks)).toEqual([
      ["hold", ["1"]],
      ["completed", ["2"]],
    ]);
    expect(groupTasksBySection([])).toEqual([]);
  });

  it("reads a state it does not know as to do", () => {
    const unknown: TodoEntry = JSON.parse(
      '{"id":"1","text":"Later","status":"pending","completed":false,"state":"someday"}',
    );
    expect(sectionIds([unknown])).toEqual([["pending", ["1"]]]);
  });

  it("shows a Claude Code or Codex list, which has no states, as in progress, to do, and done", () => {
    const tasks: TodoEntry[] = [
      { text: "Inspect", status: "completed", completed: true },
      { text: "Patch", status: "in_progress", activeForm: "Patching", completed: false },
      { text: "Verify", status: "pending", completed: false },
      { text: "Ship", completed: false },
    ];
    expect(sectionIds(tasks)).toEqual([
      ["running", ["Patch"]],
      ["pending", ["Verify", "Ship"]],
      ["completed", ["Inspect"]],
    ]);
  });

  it("folds only done and dropped tasks", () => {
    expect(
      groupTasksBySection(board).map((section) => isTaskSectionCollapsible(section.key)),
    ).toEqual([false, false, false, false, true, true]);
  });
});
