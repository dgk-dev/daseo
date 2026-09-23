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
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <span data-testid={testID}>{children}</span>
  ),
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: Record<string, unknown>) => unknown) =>
      factory({
        spacing: { 1: 4, 2: 8 },
        colors: { foregroundMuted: "#888", border: "#ddd", surface1: "#fafafa" },
        fontSize: { code: 12 },
        fontFamily: { ui: "ui", mono: "mono" },
        borderRadius: { base: 4 },
        borderWidth: { 1: 1 },
      }),
  },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => <span data-testid="chevron-down" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      (
        ({
          "message.systemNotification.agentFinished": "{{title}} finished",
          "message.systemNotification.showNotification": "{{label}}, show notification",
          "message.systemNotification.hideNotification": "{{label}}, hide notification",
        }) as Record<string, string>
      )[key]?.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values?.[name] ?? "") ?? key,
  }),
}));

vi.mock("@/utils/time", () => ({
  formatMessageTimestamp: (date: Date) => `at ${date.toISOString()}`,
}));

import { SystemNotificationRow } from "./system-notification-row";

const TEXT =
  "<paseo-system>\nAgent 8f3c2a1b (Implement) finished.\n<agent-response>\nAll tests pass.\n</agent-response>\n</paseo-system>";
const TIMESTAMP = Date.parse("2026-09-23T08:00:00.000Z");

describe("SystemNotificationRow", () => {
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

  it("shows what triggered the turn and when, with the prompt body folded", () => {
    act(() => root?.render(<SystemNotificationRow text={TEXT} timestamp={TIMESTAMP} />));

    const toggle = container?.querySelector<HTMLButtonElement>(
      '[data-testid="system-notification-toggle"]',
    );
    expect(toggle?.textContent).toBe("Implement finishedat 2026-09-23T08:00:00.000Z");
    expect(toggle?.textContent).not.toContain("8f3c2a1b");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-label")).toBe("Implement finished, show notification");
    expect(container?.querySelector('[data-testid="system-notification-body"]')).toBeNull();
    expect(container?.textContent).not.toContain("paseo-system");
  });

  it("expands and collapses the full prompt body", () => {
    act(() => root?.render(<SystemNotificationRow text={TEXT} timestamp={TIMESTAMP} />));
    const toggle = container?.querySelector<HTMLButtonElement>(
      '[data-testid="system-notification-toggle"]',
    );

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Implement finished, hide notification");
    expect(container?.querySelector('[data-testid="system-notification-body"]')?.textContent).toBe(
      "Agent 8f3c2a1b (Implement) finished.\n<agent-response>\nAll tests pass.\n</agent-response>",
    );
    expect(container?.querySelector('[data-testid="chevron-down"]')).not.toBeNull();

    act(() => toggle?.click());
    expect(container?.querySelector('[data-testid="system-notification-body"]')).toBeNull();
  });
});
