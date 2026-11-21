import { describe, expect, it } from "vitest";
import {
  formatFoldedTaskSection,
  formatTaskSectionRule,
  resolveTaskMeter,
  resolveTaskRailRowLines,
  TASK_SECTION_WORDS,
} from "./rail";
import { TASK_SECTION_ORDER } from "./sections";

describe("task rail meter", () => {
  it("draws the done share in nine cells", () => {
    expect(resolveTaskMeter({ completed: 3, total: 9 })).toEqual({
      filled: "|||",
      empty: "......",
      count: "3/9",
    });
    expect(resolveTaskMeter({ completed: 5, total: 10 }).filled).toBe("|||||");
  });

  it("is empty for no progress and for no tasks", () => {
    expect(resolveTaskMeter({ completed: 0, total: 9 })).toEqual({
      filled: "",
      empty: ".........",
      count: "0/9",
    });
    expect(resolveTaskMeter({ completed: 0, total: 0 })).toEqual({
      filled: "",
      empty: ".........",
      count: "0/0",
    });
  });

  it("shows one cell for any progress and fills the last only when all are done", () => {
    expect(resolveTaskMeter({ completed: 1, total: 100 }).filled).toBe("|");
    expect(resolveTaskMeter({ completed: 99, total: 100 }).filled).toBe("||||||||");
    expect(resolveTaskMeter({ completed: 100, total: 100 })).toEqual({
      filled: "|||||||||",
      empty: "",
      count: "100/100",
    });
  });

  it("always has nine cells", () => {
    for (let completed = 0; completed <= 13; completed += 1) {
      const meter = resolveTaskMeter({ completed, total: 13 });
      expect(meter.filled.length + meter.empty.length).toBe(9);
    }
  });
});

describe("task rail section words", () => {
  it("names every section with one short word", () => {
    expect(TASK_SECTION_ORDER.map((key) => TASK_SECTION_WORDS[key])).toEqual([
      "now",
      "ask",
      "todo",
      "hold",
      "done",
      "dropped",
    ]);
  });

  it("fits a rule and a folded line in the 200 rail", () => {
    expect(formatTaskSectionRule("pending", 5)).toBe("todo · 5");
    expect(formatTaskSectionRule("decision", 12)).toBe("ask · 12");
    expect(formatFoldedTaskSection("completed", 3, true)).toBe("3 done ▸");
    expect(formatFoldedTaskSection("deleted", 2, false)).toBe("2 dropped ▾");
  });
});

describe("task rail rows", () => {
  const running = { text: "Narrow the panel", activeForm: "Fixing the minimum", note: "see #3" };

  it("keeps a closed row to its subject on one line", () => {
    expect(resolveTaskRailRowLines({ text: "Banner", note: "later" }, "pending", false)).toEqual({
      subjectLineLimit: 1,
      doingNow: null,
      note: null,
    });
  });

  it("shows what the task in progress is doing without opening it", () => {
    expect(resolveTaskRailRowLines(running, "running", false)).toEqual({
      subjectLineLimit: 1,
      doingNow: "Fixing the minimum",
      note: null,
    });
  });

  it("opens to the full subject, the doing-now line and the note", () => {
    expect(resolveTaskRailRowLines(running, "running", true)).toEqual({
      subjectLineLimit: null,
      doingNow: "Fixing the minimum",
      note: "see #3",
    });
  });

  it("leaves out a doing-now line that repeats the subject or belongs to another state", () => {
    const same = { text: "Build", activeForm: "Build" };
    expect(resolveTaskRailRowLines(same, "running", true).doingNow).toBeNull();
    expect(resolveTaskRailRowLines(running, "pending", true).doingNow).toBeNull();
  });
});
