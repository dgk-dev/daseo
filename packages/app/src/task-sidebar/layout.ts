/**
 * Where the viewed session's task list lives (Daseo delta 101): in the right panel, which is the
 * overlay on compact layouts and the pinned sidebar on wide layouts outside focus mode. The board
 * above the composer shows it only in desktop focus mode, a wide-layout state that compact
 * layouts ignore.
 */
export function isTaskListInSidebar(input: {
  isCompact: boolean;
  isFocusModeEnabled: boolean;
}): boolean {
  return input.isCompact || !input.isFocusModeEnabled;
}

/**
 * Whether the pinned right sidebar exists: wide layouts outside focus mode. Only it opens by itself
 * when a task list first appears (compact never does: the overlay would cover the chat).
 */
export function hasPinnedTaskSidebar(input: {
  isCompact: boolean;
  isFocusModeEnabled: boolean;
}): boolean {
  return !input.isCompact && !input.isFocusModeEnabled;
}
