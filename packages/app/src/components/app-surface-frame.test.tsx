// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import React, { type ReactNode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  agentListGestureEnabled: [] as boolean[],
  explorerHostEnabled: [] as boolean[],
}));

vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/utils/desktop-window", () => ({
  WindowChromeRegion: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/mobile-panels/gestures", () => ({
  useOpenAgentListGesture: (enabled: boolean) => {
    recorded.agentListGestureEnabled.push(enabled);
    return {};
  },
}));

vi.mock("@/components/compact-explorer-sidebar-host", () => ({
  CompactExplorerSidebarHost: ({
    children,
    enabled,
  }: {
    children: ReactNode;
    enabled: boolean;
  }) => {
    recorded.explorerHostEnabled.push(enabled);
    return children;
  },
}));

import { AppSurfaceFrame } from "./app-surface-frame";

const surfaceStyle = { flex: 1 } as const;
const lifecycle = { mounts: 0, unmounts: 0 };

function RoutedContent() {
  useEffect(() => {
    lifecycle.mounts += 1;
    return () => {
      lifecycle.unmounts += 1;
    };
  }, []);
  return null;
}

function frame({ compact, chromeEnabled = true }: { compact: boolean; chromeEnabled?: boolean }) {
  return (
    <AppSurfaceFrame
      isCompactLayout={compact}
      chromeEnabled={chromeEnabled}
      sidebar={null}
      sidebarCorners="top-left"
      contentCorners="top-right"
      surfaceStyle={surfaceStyle}
      overlays={null}
    >
      <RoutedContent />
    </AppSurfaceFrame>
  );
}

afterEach(() => {
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
  recorded.agentListGestureEnabled.length = 0;
  recorded.explorerHostEnabled.length = 0;
});

describe("AppSurfaceFrame", () => {
  it("keeps the routed content mounted when the layout crosses the compact width", () => {
    const { rerender, unmount } = render(frame({ compact: true }));
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    act(() => rerender(frame({ compact: false })));
    act(() => rerender(frame({ compact: true })));
    act(() => rerender(frame({ compact: false })));

    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    unmount();
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 1 });
  });

  it("enables the compact gestures only in the compact layout with chrome", () => {
    const { rerender, unmount } = render(frame({ compact: true }));
    expect(recorded.agentListGestureEnabled.at(-1)).toBe(true);
    expect(recorded.explorerHostEnabled.at(-1)).toBe(true);

    act(() => rerender(frame({ compact: false })));
    expect(recorded.agentListGestureEnabled.at(-1)).toBe(false);
    expect(recorded.explorerHostEnabled.at(-1)).toBe(false);

    act(() => rerender(frame({ compact: true, chromeEnabled: false })));
    expect(recorded.agentListGestureEnabled.at(-1)).toBe(false);
    expect(recorded.explorerHostEnabled.at(-1)).toBe(false);
    unmount();
  });
});
