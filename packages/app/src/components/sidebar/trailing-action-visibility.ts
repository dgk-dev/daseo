import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings/storage";

// Pure row-slot rules shared by every sidebar row renderer (project, status, pinned), kept out
// of the component modules so they can be tested without React Native.

/** Whether the slot has anything to draw for this workspace under the current preference. */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  if (trailing === "diff") return workspace.diffStat !== null;
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return false;
}

/**
 * What the trailing slot shows for a row. Derived in one place because three row renderers
 * share it: the two project-mode rows and the status-mode row. The rule used to be copied
 * into each of them and immediately drifted — one call site kept hiding the diff after the
 * others stopped.
 *
 * The trailing content survives the kebab on hover and fades under the scrim instead of
 * blinking out. Touch has no hover, so its permanent kebab still hides the content outright
 * rather than scrimming an unhovered row whose background doesn't match the gradient.
 */
export function resolveTrailingActionVisibility({
  workspace,
  trailing,
  hasArchiveAction,
  isHovered,
  isTouchPlatform,
  showShortcut,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
  hasArchiveAction: boolean;
  isHovered: boolean;
  isTouchPlatform: boolean;
  showShortcut: boolean;
}): {
  showTrailing: boolean;
  showKebab: boolean;
  showScrim: boolean;
  renderSlot: boolean;
  reserveSlotWidth: boolean;
} {
  const hasTrailing = hasSidebarWorkspaceTrailing({ workspace, trailing });
  const showKebab = Boolean(hasArchiveAction && (isHovered || isTouchPlatform)) && !showShortcut;
  const showTrailing = hasTrailing && !showShortcut && (isHovered || !showKebab);
  return {
    showTrailing,
    showKebab,
    // The scrim paints the row's own hover background, so it can only be drawn on a hovered
    // row — over an unhovered one the gradient fades to the wrong color. That is also why
    // touch, which shows the kebab without ever hovering, never gets one.
    showScrim: showKebab && isHovered,
    renderSlot: hasArchiveAction || hasTrailing,
    // The slot only holds width for something that permanently sits in it. Trailing content
    // does; the kebab only does on touch, where there is no hover for it to appear on and so
    // no scrim to let it overlay the title. Everywhere else the width goes back to the title
    // and the kebab fades in over its tail.
    reserveSlotWidth: hasTrailing || (hasArchiveAction && isTouchPlatform),
  };
}
