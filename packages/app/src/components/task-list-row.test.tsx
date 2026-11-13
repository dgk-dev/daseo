/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0.5: 2, 2: 8, 3: 12 },
    fontSize: { sm: 14, base: 16 },
    colors: {
      foreground: "#foreground",
      foregroundMuted: "#muted",
      foregroundExtraMuted: "#extra-muted",
      statusDotRunning: "#running",
      statusDotWarning: "#warning",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({
    children,
    style,
    numberOfLines,
  }: React.PropsWithChildren<{
    style?: Record<string, unknown> | Record<string, unknown>[];
    numberOfLines?: number;
  }>) => {
    const resolvedStyle = Object.assign({}, ...[style ?? []].flat().filter(Boolean));
    return React.createElement(
      "span",
      {
        "data-color": resolvedStyle.color,
        "data-decoration": resolvedStyle.textDecorationLine,
        "data-size": resolvedStyle.fontSize,
        "data-lines": numberOfLines,
      },
      children,
    );
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: Record<string, unknown>) => {
      const themedProps = (uniProps as (value: typeof theme) => Record<string, unknown>)(theme);
      return React.createElement(Component, { ...props, ...themedProps });
    },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Circle: createIcon("Circle"),
    CircleCheck: createIcon("CircleCheck"),
    CircleDot: createIcon("CircleDot"),
    CirclePause: createIcon("CirclePause"),
    CircleQuestionMark: createIcon("CircleQuestionMark"),
    CircleX: createIcon("CircleX"),
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { TaskListRow } from "./task-list-row";

const pendingTask = { text: "Queued", completed: false } as const;
const runningTask = {
  text: "Run checks",
  activeForm: "Running checks",
  completed: false,
  status: "in_progress",
} as const;
const completedTask = { text: "Finished", completed: true, status: "completed" } as const;
const decisionTask = {
  text: "Pick a model",
  completed: false,
  status: "pending",
  state: "decision",
  note: "Opus or Sonnet",
} as const;

describe("TaskListRow", () => {
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

  it("keeps pending tasks muted", () => {
    act(() => root.render(<TaskListRow task={pendingTask} />));

    expect(container.querySelector('[data-icon="Circle"]')?.getAttribute("color")).toBe("#muted");
    expect(container.querySelector("[data-color]")?.getAttribute("data-color")).toBe("#muted");
  });

  it("foregrounds only the running task with the running blue circle dot", () => {
    act(() => root.render(<TaskListRow task={runningTask} />));

    expect(container.textContent).toBe("Running checks");
    expect(container.querySelector('[data-icon="CircleDot"]')?.getAttribute("color")).toBe(
      "#running",
    );
    expect(container.querySelector("[data-color]")?.getAttribute("data-color")).toBe("#foreground");
  });

  it("extra-mutes completed tasks with a circle check", () => {
    act(() => root.render(<TaskListRow task={completedTask} />));

    expect(container.querySelector('[data-icon="CircleCheck"]')?.getAttribute("color")).toBe(
      "#extra-muted",
    );
    const text = container.querySelector("[data-color]");
    expect(text?.getAttribute("data-color")).toBe("#extra-muted");
    expect(text?.getAttribute("data-decoration")).toBe("line-through");
  });

  it("keeps the board's one-line row with the state and note as a suffix", () => {
    act(() => root.render(<TaskListRow task={decisionTask} />));

    // No i18n instance in this test: the state word renders as its key.
    expect(container.textContent).toBe(
      "Pick a model · message.todo.state.decision: Opus or Sonnet",
    );
  });
});

function renderedLines(
  container: HTMLElement,
): { text: string | null; color: string | null; size: string | null }[] {
  return [...container.querySelectorAll("[data-color]")].map((line) => ({
    text: line.textContent,
    color: line.getAttribute("data-color"),
    size: line.getAttribute("data-size"),
  }));
}

describe("TaskListRow in the task sidebar (Daseo delta 101)", () => {
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

  it("puts the note on its own smaller muted line, without the state word", () => {
    act(() => root.render(<TaskListRow task={decisionTask} variant="sidebar" />));

    expect(renderedLines(container)).toEqual([
      { text: "Pick a model", color: "#foreground", size: "16" },
      { text: "Opus or Sonnet", color: "#muted", size: "14" },
    ]);
    expect(container.querySelector('[data-icon="CircleQuestionMark"]')?.getAttribute("color")).toBe(
      "#warning",
    );
    expect(container.querySelector('[data-lines="3"]')?.textContent).toBe("Pick a model");
  });

  it("shows what the task in progress is doing under its subject", () => {
    act(() => root.render(<TaskListRow task={runningTask} variant="sidebar" />));

    expect(renderedLines(container).map((line) => line.text)).toEqual([
      "Run checks",
      "Running checks",
    ]);
  });

  it("shows a task without a note on one line", () => {
    act(() => root.render(<TaskListRow task={pendingTask} variant="sidebar" />));

    expect(renderedLines(container).map((line) => line.text)).toEqual(["Queued"]);
  });
});
