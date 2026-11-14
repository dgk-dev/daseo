import { describe, expect, it } from "vitest";
import { computeWorkspaceTabLayout } from "@/screens/workspace/workspace-tab-layout";

// Index-only tab = 14 + 12 * 2 + 22 = 60. Title floors at 7 px per cell: active 60 + 7 * 7 = 109,
// inactive 60 + 4 * 7 = 88. The tab budget is viewport - 120 (actions) - 16 (row padding) - gaps.
const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  maxTabWidth: 200,
  tabLeadingWidth: 14,
  tabHorizontalPadding: 12,
  estimatedCharWidth: 7,
  closeButtonWidth: 22,
};

function layoutFor(tabBudget: number, tabCount: number, activeIndex: number) {
  const viewportWidth =
    tabBudget +
    metrics.actionsReservedWidth +
    metrics.rowPaddingHorizontal * 2 +
    (tabCount - 1) * 4;
  return computeWorkspaceTabLayout({ viewportWidth, tabCount, activeIndex, metrics });
}

describe("computeWorkspaceTabLayout", () => {
  it("caps equal-width tabs at the ideal width when there is extra horizontal space", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabCount: 3,
      activeIndex: 0,
      metrics,
    });
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([200, 200, 200]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("shares the row equally while the share covers the active tab's title floor", () => {
    const result = layoutFor(376, 3, 1);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([125, 125, 125]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("holds the active tab at its title floor while inactive titles shrink", () => {
    const result = layoutFor(400, 4, 2);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([97, 97, 109, 97]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps inactive titles down to their floor before any tab goes index-only", () => {
    const result = layoutFor(109 + 3 * 88, 4, 0);
    expect(result.items.map((item) => item.width)).toEqual([109, 88, 88, 88]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("drops inactive tabs to the index when their titles no longer fit, never the active one", () => {
    const result = layoutFor(109 + 3 * 88 - 1, 4, 3);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([60, 60, 60, 192]);
    expect(result.items.map((item) => item.showLabel)).toEqual([false, false, false, true]);
  });

  it("scrolls only when the active title floor and index-only tabs cannot fit", () => {
    const result = layoutFor(109 + 3 * 60 - 1, 4, 1);
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([60, 109, 60, 60]);
    expect(result.items.map((item) => item.showLabel)).toEqual([false, true, false, false]);
  });

  it("shrinks every tab to the inactive floor when no tab is active", () => {
    const titled = layoutFor(4 * 88, 4, -1);
    expect(titled.items.map((item) => item.width)).toEqual([88, 88, 88, 88]);
    expect(titled.items.every((item) => item.showLabel)).toBe(true);

    const indexOnly = layoutFor(4 * 88 - 1, 4, -1);
    expect(indexOnly.requiresHorizontalScrollFallback).toBe(false);
    expect(indexOnly.items.every((item) => !item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabCount: 0,
      activeIndex: -1,
      metrics,
    });
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });
});
