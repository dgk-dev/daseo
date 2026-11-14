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
    fontFamily: { mono: "mono" },
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
    testID,
  }: React.PropsWithChildren<{
    style?: Record<string, unknown> | Record<string, unknown>[];
    numberOfLines?: number;
    testID?: string;
  }>) => {
    const resolvedStyle = Object.assign({}, ...[style ?? []].flat().filter(Boolean));
    return React.createElement(
      "span",
      {
        "data-testid": testID,
        "data-color": resolvedStyle.color,
        "data-decoration": resolvedStyle.textDecorationLine,
        "data-size": resolvedStyle.fontSize,
        "data-line-height": resolvedStyle.lineHeight,
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
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { TaskListRow } from "./task-list-row";

const MARKER = '[data-testid="task-state-marker"]';
const SUBJECT = '[data-color]:not([data-testid="task-state-marker"])';

function marker(container: HTMLElement): { text: string | null; color: string | null } {
  const element = container.querySelector(MARKER);
  return { text: element?.textContent ?? null, color: element?.getAttribute("data-color") ?? null };
}

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

    expect(marker(container)).toEqual({ text: "[ ]", color: "#muted" });
    expect(container.querySelector(SUBJECT)?.getAttribute("data-color")).toBe("#muted");
  });

  it("foregrounds only the running task behind the running [>] marker", () => {
    act(() => root.render(<TaskListRow task={runningTask} />));

    expect(container.querySelector(SUBJECT)?.textContent).toBe("Running checks");
    expect(marker(container)).toEqual({ text: "[>]", color: "#running" });
    expect(container.querySelector(SUBJECT)?.getAttribute("data-color")).toBe("#foreground");
  });

  it("extra-mutes completed tasks behind an [x] marker", () => {
    act(() => root.render(<TaskListRow task={completedTask} />));

    expect(marker(container)).toEqual({ text: "[x]", color: "#extra-muted" });
    const text = container.querySelector(SUBJECT);
    expect(text?.getAttribute("data-color")).toBe("#extra-muted");
    expect(text?.getAttribute("data-decoration")).toBe("line-through");
  });

  it("keeps the board's one-line row with the state and note as a suffix", () => {
    act(() => root.render(<TaskListRow task={decisionTask} />));

    // No i18n instance in this test: the state word renders as its key.
    expect(container.querySelector(SUBJECT)?.textContent).toBe(
      "Pick a model · message.todo.state.decision: Opus or Sonnet",
    );
    expect(marker(container)).toEqual({ text: "[?]", color: "#warning" });
  });
});

function renderedLines(container: HTMLElement): {
  text: string | null;
  color: string | null;
  size: string | null;
  lineHeight: string | null;
}[] {
  return [...container.querySelectorAll(SUBJECT)].map((line) => ({
    text: line.textContent,
    color: line.getAttribute("data-color"),
    size: line.getAttribute("data-size"),
    lineHeight: line.getAttribute("data-line-height"),
  }));
}

it("prints every state as its checkbox marker (Daseo delta 116)", async () => {
  const { TASK_STATE_MARKERS } = await import("./task-list-row");
  expect(TASK_STATE_MARKERS).toEqual({
    running: "[>]",
    decision: "[?]",
    pending: "[ ]",
    hold: "[=]",
    completed: "[x]",
    deleted: "[-]",
  });
});

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
      { text: "Pick a model", color: "#foreground", size: "16", lineHeight: "22" },
      { text: "Opus or Sonnet", color: "#muted", size: "14", lineHeight: "20" },
    ]);
    expect(marker(container)).toEqual({ text: "[?]", color: "#warning" });
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
