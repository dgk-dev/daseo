/**
 * Where the viewed session's task list lives (Daseo delta 101): in the right sidebar wherever that
 * sidebar exists (wide layouts outside focus mode), else on the board above the composer.
 */
export function isTaskListInSidebar(input: {
  isCompact: boolean;
  isFocusModeEnabled: boolean;
}): boolean {
  return !input.isCompact && !input.isFocusModeEnabled;
}
