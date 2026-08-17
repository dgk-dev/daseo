/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    accessibilityState,
    children,
    onPress,
    testID,
  }: {
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button
      type="button"
      aria-expanded={accessibilityState?.expanded}
      aria-label={accessibilityLabel}
      data-testid={testID}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: Record<string, unknown>) => unknown) =>
      factory({
        spacing: { 1: 4, 3: 12 },
        colors: { foregroundMuted: "#888" },
        fontSize: { sm: 14 },
      }),
  },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => <span data-testid="chevron-down" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
}));

import { CollapsedWorkProvider, type CollapsedWorkController } from "./collapsed-work-context";
import { CollapsedWorkRow } from "./collapsed-work-row";

describe("CollapsedWorkRow", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function renderController(controller: CollapsedWorkController) {
    act(() => {
      root?.render(
        <CollapsedWorkProvider value={controller}>
          <CollapsedWorkRow turnKey="stable-turn" />
        </CollapsedWorkProvider>,
      );
    });
  }

  it("announces and toggles the complete lossless work disclosure", () => {
    const toggle = vi.fn();
    renderController({
      getWorkCount: () => 3,
      getDurationMs: () => 62_000,
      isExpanded: () => false,
      toggle,
    });

    const collapsed = container?.querySelector<HTMLButtonElement>(
      '[data-testid="collapsed-work-row"]',
    );
    expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed?.getAttribute("aria-label")).toBe("Worked for 1m 2s, show work details");
    expect(container?.querySelector('[data-testid="chevron-right"]')).not.toBeNull();

    act(() => collapsed?.click());
    expect(toggle).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith("stable-turn");

    renderController({
      getWorkCount: () => 3,
      getDurationMs: () => 62_000,
      isExpanded: () => true,
      toggle,
    });
    const expanded = container?.querySelector<HTMLButtonElement>(
      '[data-testid="collapsed-work-row"]',
    );
    expect(expanded?.getAttribute("aria-expanded")).toBe("true");
    expect(expanded?.getAttribute("aria-label")).toBe("Worked for 1m 2s, hide work details");
    expect(container?.querySelector('[data-testid="chevron-down"]')).not.toBeNull();
  });

  it("uses the hidden-step count when duration is unavailable and omits empty rows", () => {
    const toggle = vi.fn();
    renderController({
      getWorkCount: () => 1,
      getDurationMs: () => undefined,
      isExpanded: () => false,
      toggle,
    });
    expect(container?.textContent).toContain("1 step");

    renderController({
      getWorkCount: () => 0,
      getDurationMs: () => undefined,
      isExpanded: () => false,
      toggle,
    });
    expect(container?.querySelector('[data-testid="collapsed-work-row"]')).toBeNull();
  });
});
