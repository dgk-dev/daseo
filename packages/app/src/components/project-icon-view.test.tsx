/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    colors: {
      surface3: "#graphite",
      foregroundMuted: "#muted",
    },
  },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!Array.isArray(style)) return (style as Record<string, unknown>) ?? {};
  return Object.assign({}, ...style.flat(Infinity).filter(Boolean));
}

vi.mock("react-native", () => ({
  View: ({ children, style }: React.PropsWithChildren<{ style?: unknown }>) => {
    const resolved = flattenStyle(style);
    return React.createElement(
      "div",
      {
        "data-background": resolved.backgroundColor,
        "data-radius": resolved.borderRadius,
        "data-width": resolved.width,
      },
      children,
    );
  },
  Text: ({ children, style }: React.PropsWithChildren<{ style?: unknown }>) => {
    const resolved = flattenStyle(style);
    return React.createElement("span", { "data-color": resolved.color }, children);
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
}));

vi.mock("@/components/project-icon-image", () => ({
  ProjectIconImage: () => React.createElement("div", { "data-project-image": true }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ProjectIconView } from "./project-icon-view";

const FALLBACK_TEXT_STYLE = { fontSize: 9 } as const;

describe("ProjectIconView", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("uses a quiet theme-derived fallback instead of a project-specific color", () => {
    act(() =>
      root.render(
        <ProjectIconView
          iconDataUri={null}
          initial="D"
          projectViewKey="daseo"
          size={16}
          textStyle={FALLBACK_TEXT_STYLE}
        />,
      ),
    );

    const tile = container.querySelector("[data-background]");
    expect(tile?.getAttribute("data-background")).toBe("#graphite");
    expect(tile?.getAttribute("data-radius")).toBe("4");
    expect(tile?.getAttribute("data-width")).toBe("16");
    expect(container.querySelector("[data-color]")?.getAttribute("data-color")).toBe("#muted");
    expect(container.textContent).toBe("D");
  });
});
