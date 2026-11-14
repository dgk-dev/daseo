export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabLabelLengths: number[];
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
  width: number;
  showLabel: boolean;
  labelCharCap: number;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  requiresHorizontalScrollFallback: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelLengths.length;
  if (tabCount === 0) {
    return {
      items: [],
      requiresHorizontalScrollFallback: false,
    };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - input.metrics.rowHorizontalInset * 2 - input.metrics.actionsReservedWidth,
  );
  const rowOverhead =
    input.metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * input.metrics.tabGap;
  const availableTabsWidth = Math.max(0, availableWidth - rowOverhead);
  const leadingOnlyTabWidth =
    input.metrics.tabLeadingWidth +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const leadingOnlyTotalTabsWidth = leadingOnlyTabWidth * tabCount;
  const requiresHorizontalScrollFallback = availableTabsWidth < leadingOnlyTotalTabsWidth;
  const resolvedWidth = requiresHorizontalScrollFallback
    ? leadingOnlyTabWidth
    : clamp(availableTabsWidth / tabCount, leadingOnlyTabWidth, input.metrics.maxTabWidth);
  const resolvedWidths = Array.from({ length: tabCount }, () => resolvedWidth);

  const roundedWidths = resolvedWidths.map((width) =>
    Math.round(clamp(width, leadingOnlyTabWidth, input.metrics.maxTabWidth)),
  );

  return {
    items: roundedWidths.map((width) => {
      const rawCharCap = Math.floor(
        (width - leadingOnlyTabWidth) / input.metrics.estimatedCharWidth,
      );
      const labelCharCap = Math.max(0, rawCharCap);
      return {
        width,
        showLabel: labelCharCap > 0,
        labelCharCap,
      };
    }),
    requiresHorizontalScrollFallback,
  };
}
