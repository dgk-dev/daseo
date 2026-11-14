export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabCount: number;
  /** Index of the pane's active tab, or -1 when none is active. */
  activeIndex: number;
  metrics: {
    rowHorizontalInset: number;
    actionsReservedWidth: number;
    rowPaddingHorizontal: number;
    tabGap: number;
    maxTabWidth: number;
    tabLeadingWidth: number;
    tabHorizontalPadding: number;
    estimatedCharWidth: number;
    closeButtonWidth: number;
  };
}

export interface WorkspaceTabLayoutItem {
  /** The most this tab may take; tabs size to their content up to it. */
  width: number;
  showLabel: boolean;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  requiresHorizontalScrollFallback: boolean;
}

// Daseo delta 112: a narrow tab row truncates titles the way tmux truncates window names. The
// title floors are in character cells and include the ellipsis cell: the active tab keeps at
// least six cells of title (`3: tmux r…`), an inactive tab at least three (`1: boa…`).
export const ACTIVE_TAB_MIN_LABEL_CELLS = 7;
export const INACTIVE_TAB_MIN_LABEL_CELLS = 4;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Width budget per tab, shrinking in this order as the row narrows:
 * 1. every tab shares the row equally, up to `maxTabWidth`;
 * 2. the active tab holds its title floor and the inactive tabs share the rest, down to their
 *    own title floor;
 * 3. the inactive tabs drop to the bare `N:` index and the active tab takes what is left;
 * 4. the row scrolls, with the active tab still at its title floor.
 * The active tab is never index-only.
 */
export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const { metrics } = input;
  const { tabCount } = input;
  if (tabCount === 0) {
    return { items: [], requiresHorizontalScrollFallback: false };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - metrics.rowHorizontalInset * 2 - metrics.actionsReservedWidth,
  );
  const rowOverhead = metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * metrics.tabGap;
  const available = Math.max(0, availableWidth - rowOverhead);

  const indexOnlyWidth =
    metrics.tabLeadingWidth + metrics.tabHorizontalPadding * 2 + metrics.closeButtonWidth;
  const maxWidth = Math.max(metrics.maxTabWidth, indexOnlyWidth);
  const activeFloor = Math.min(
    maxWidth,
    indexOnlyWidth + ACTIVE_TAB_MIN_LABEL_CELLS * metrics.estimatedCharWidth,
  );
  const inactiveFloor = Math.min(
    maxWidth,
    indexOnlyWidth + INACTIVE_TAB_MIN_LABEL_CELLS * metrics.estimatedCharWidth,
  );
  const hasActive = input.activeIndex >= 0 && input.activeIndex < tabCount;
  const inactiveCount = hasActive ? tabCount - 1 : tabCount;
  const activeReserve = hasActive ? activeFloor : 0;

  const build = (
    activeWidth: number,
    inactiveWidth: number,
    inactiveShowLabel: boolean,
    requiresHorizontalScrollFallback: boolean,
  ): WorkspaceTabLayoutResult => ({
    items: Array.from({ length: tabCount }, (_, index) =>
      hasActive && index === input.activeIndex
        ? { width: Math.round(activeWidth), showLabel: true }
        : { width: Math.round(inactiveWidth), showLabel: inactiveShowLabel },
    ),
    requiresHorizontalScrollFallback,
  });

  // 1. Equal shares, as long as the share covers the active tab's title floor.
  const share = clamp(available / tabCount, 0, maxWidth);
  if (share >= (hasActive ? activeFloor : inactiveFloor)) {
    return build(share, share, true, false);
  }

  // 2. Active tab at its floor, inactive titles shrink toward theirs.
  if (activeReserve + inactiveCount * inactiveFloor <= available) {
    const inactiveWidth =
      inactiveCount > 0 ? clamp((available - activeReserve) / inactiveCount, 0, maxWidth) : 0;
    return build(activeFloor, inactiveWidth, true, false);
  }

  // 3. Inactive tabs go index-only; the active tab keeps the rest.
  if (activeReserve + inactiveCount * indexOnlyWidth <= available) {
    const activeWidth = clamp(available - inactiveCount * indexOnlyWidth, activeFloor, maxWidth);
    return build(activeWidth, indexOnlyWidth, false, false);
  }

  // 4. Scroll.
  return build(activeFloor, indexOnlyWidth, false, true);
}
