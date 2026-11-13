import { describe, expect, it } from "vitest";
import { hasPinnedTaskSidebar, isTaskListInSidebar } from "./layout";

describe("isTaskListInSidebar", () => {
  it("puts the task list in the right panel on compact layouts, focus mode or not", () => {
    expect(isTaskListInSidebar({ isCompact: true, isFocusModeEnabled: false })).toBe(true);
    expect(isTaskListInSidebar({ isCompact: true, isFocusModeEnabled: true })).toBe(true);
  });

  it("puts it in the wide sidebar outside focus mode and on the board in focus mode", () => {
    expect(isTaskListInSidebar({ isCompact: false, isFocusModeEnabled: false })).toBe(true);
    expect(isTaskListInSidebar({ isCompact: false, isFocusModeEnabled: true })).toBe(false);
  });
});

describe("hasPinnedTaskSidebar", () => {
  it("exists only on wide layouts outside focus mode", () => {
    expect(hasPinnedTaskSidebar({ isCompact: false, isFocusModeEnabled: false })).toBe(true);
    expect(hasPinnedTaskSidebar({ isCompact: false, isFocusModeEnabled: true })).toBe(false);
    expect(hasPinnedTaskSidebar({ isCompact: true, isFocusModeEnabled: false })).toBe(false);
    expect(hasPinnedTaskSidebar({ isCompact: true, isFocusModeEnabled: true })).toBe(false);
  });
});
