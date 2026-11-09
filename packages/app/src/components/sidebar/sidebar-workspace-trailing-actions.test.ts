import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings/storage";
import { resolveTrailingActionVisibility } from "./trailing-action-visibility";

// The phone has no hover, so a workspace row's kebab (copy path, rename, pin, archive) must be
// on screen whenever the row offers those actions, whatever else the row shows. The owner
// reported a sidebar "without the three-dot menu" on the Fold (2026-11-09); these cases pin the
// rule every row type (project, status, pinned) shares.

function workspace(input: {
  diffStat: SidebarWorkspaceEntry["diffStat"];
  statusEnteredAt: SidebarWorkspaceEntry["statusEnteredAt"];
}): SidebarWorkspaceEntry {
  return input as unknown as SidebarWorkspaceEntry;
}

const rows = [
  workspace({ diffStat: null, statusEnteredAt: null }),
  workspace({
    diffStat: { additions: 3, deletions: 1 },
    statusEnteredAt: new Date("2026-11-09T07:00:00Z"),
  }),
] as const;
const trailingSettings: SidebarWorkspaceTrailing[] = ["none", "diff", "timestamp"];

describe("workspace row kebab on a touch screen", () => {
  it("shows the kebab and reserves its width on every row that has row actions", () => {
    for (const row of rows) {
      for (const trailing of trailingSettings) {
        const visibility = resolveTrailingActionVisibility({
          workspace: row,
          trailing,
          hasArchiveAction: true,
          isHovered: false,
          isTouchPlatform: true,
          showShortcut: false,
        });
        expect({ trailing, ...visibility }).toMatchObject({
          trailing,
          showKebab: true,
          renderSlot: true,
          reserveSlotWidth: true,
          showScrim: false,
        });
      }
    }
  });

  it("gives the slot back to the shortcut badge only while the badge is up", () => {
    const visibility = resolveTrailingActionVisibility({
      workspace: rows[1],
      trailing: "diff",
      hasArchiveAction: true,
      isHovered: false,
      isTouchPlatform: true,
      showShortcut: true,
    });
    expect(visibility.showKebab).toBe(false);
  });

  it("keeps the kebab hover-revealed on pointer platforms", () => {
    const hidden = resolveTrailingActionVisibility({
      workspace: rows[0],
      trailing: "none",
      hasArchiveAction: true,
      isHovered: false,
      isTouchPlatform: false,
      showShortcut: false,
    });
    const hovered = resolveTrailingActionVisibility({
      workspace: rows[0],
      trailing: "none",
      hasArchiveAction: true,
      isHovered: true,
      isTouchPlatform: false,
      showShortcut: false,
    });
    expect([hidden.showKebab, hovered.showKebab]).toEqual([false, true]);
  });
});
