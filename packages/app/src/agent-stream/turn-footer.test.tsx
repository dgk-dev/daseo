/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <span data-testid={testID}>{children}</span>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: Record<string, unknown>) => unknown)({
            spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
            fontFamily: { ui: "system-ui", mono: "monospace" },
            colors: {
              foregroundMuted: "#aaa",
              foregroundExtraMuted: "#888",
              palette: { amber: { 500: "#f0b429", 700: "#b7791f" } },
            },
          })
        : factory,
  },
  useUnistyles: () => ({ rt: { breakpoint: "md" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/components/message", () => ({
  AssistantTurnFooter: () => null,
  LiveElapsed: () => <span data-testid="running-turn-timestamp" />,
  STREAM_METADATA_FONT_SIZE: 11,
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () => <button data-testid="running-turn-fork" type="button" />,
}));

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: () => <span data-testid="running-turn-loader" />,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

import { TurnFooter } from "./turn-footer";

const unusedRunningTurnStrategy = null as unknown as React.ComponentProps<
  typeof TurnFooter
>["strategy"];

const manualCompaction = {
  startedAt: new Date("2026-09-17T10:00:00.000Z"),
  trigger: "manual",
} as const;

describe("TurnFooter", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("places the running-turn fork between the loader and timestamp", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TurnFooter
          isRunning
          inFlightTurnStartedAt={new Date("2026-08-01T10:00:00.000Z")}
          host={null}
          strategy={unusedRunningTurnStrategy}
          supportsTimelineCursor
          onForkInFlightTurn={vi.fn()}
        />,
      );
    });

    const footer = container.querySelector('[data-testid="turn-working-indicator"]');
    const controls = Array.from(footer?.querySelectorAll("[data-testid]") ?? []).map((node) =>
      node.getAttribute("data-testid"),
    );

    expect(controls).toEqual([
      "running-turn-loader",
      "running-turn-fork",
      "running-turn-timestamp",
    ]);
  });

  it("shows a compaction with no foreground turn as running status without a fork", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <TurnFooter
          isRunning
          inFlightTurnStartedAt={null}
          activeCompaction={manualCompaction}
          host={null}
          strategy={unusedRunningTurnStrategy}
          supportsTimelineCursor
        />,
      );
    });

    const footer = container.querySelector('[data-testid="turn-working-indicator"]');
    const controls = Array.from(footer?.querySelectorAll("[data-testid]") ?? []).map((node) =>
      node.getAttribute("data-testid"),
    );

    expect(controls).toEqual([
      "running-turn-loader",
      "turn-compacting-label",
      "running-turn-timestamp",
    ]);
  });

  function renderFooter(props: Partial<React.ComponentProps<typeof TurnFooter>>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <TurnFooter
          isRunning={false}
          inFlightTurnStartedAt={null}
          host={null}
          strategy={unusedRunningTurnStrategy}
          supportsTimelineCursor
          {...props}
        />,
      );
    });
    return container;
  }

  it("shows the spinner and the newest wait with the others counted for an agent waiting in background", () => {
    const footer = renderFooter({ backgroundWait: { label: "web build", moreCount: 2 } });

    const indicator = footer.querySelector('[data-testid="turn-background-wait-indicator"]');
    expect(indicator?.querySelector('[data-testid="running-turn-loader"]')).not.toBeNull();
    expect(
      indicator?.querySelector('[data-testid="turn-background-wait-label"]')?.textContent,
    ).toBe('message.backgroundWait.waiting {"label":"web build +2"}');
    expect(indicator?.querySelector('[data-testid="running-turn-fork"]')).toBeNull();
    expect(indicator?.querySelector('[data-testid="running-turn-timestamp"]')).toBeNull();
  });

  it("names a single wait without a count, and falls back when the wait has no description", () => {
    const single = renderFooter({ backgroundWait: { label: "deploy log", moreCount: 0 } });
    expect(single.querySelector('[data-testid="turn-background-wait-label"]')?.textContent).toBe(
      'message.backgroundWait.waiting {"label":"deploy log"}',
    );
    act(() => root?.unmount());
    root = null;
    container?.remove();

    const unlabeled = renderFooter({ backgroundWait: { label: null, moreCount: 0 } });
    expect(unlabeled.querySelector('[data-testid="turn-background-wait-label"]')?.textContent).toBe(
      "message.backgroundWait.waitingUnlabeled",
    );
  });

  it("renders nothing for an idle agent without background waits", () => {
    const footer = renderFooter({ backgroundWait: null });

    expect(footer.querySelector('[data-testid="turn-background-wait-indicator"]')).toBeNull();
    expect(footer.querySelector('[data-testid="turn-working-indicator"]')).toBeNull();
    expect(footer.textContent).toBe("");
  });
});
