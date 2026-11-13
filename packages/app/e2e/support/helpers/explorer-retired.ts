import { test } from "@playwright/test";

// Daseo delta 101: the right panel holds the viewed session's task list on every layout, and the
// explorer (Changes, Files, PR, commit history, and the branch switcher in the Changes header) is
// retired from the UI, so no button, shortcut, or swipe opens it. Its code stays for upstream
// cherry-picks; a spec that drives it skips at the point it would open it.
export const EXPLORER_RETIRED_REASON =
  "Daseo delta 101: the explorer is retired from the UI; the right sidebar holds the task list";

/** Skips the running test where it would open the retired explorer. */
export function skipRetiredExplorer(): void {
  test.skip(true, EXPLORER_RETIRED_REASON);
}
