import { describe, expect, test } from "vitest";
import {
  BROWSER_AUTOMATION_EDITING_COMMANDS,
  BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS,
  BROWSER_TAB_DISCARD_AFTER_IDLE_MS,
  BrowserTabDiscarder,
  isEditingKeyInput,
} from "./discard.js";
import type { BrowserTabDiscardCandidate } from "./lifecycle.js";

class FakeLifecycle {
  public readonly discarded: number[] = [];
  public readonly askedIdleMs: number[] = [];
  public refuse = new Set<number>();

  public constructor(private readonly candidates: BrowserTabDiscardCandidate[]) {}

  public listDiscardCandidates(minIdleMs: number): BrowserTabDiscardCandidate[] {
    this.askedIdleMs.push(minIdleMs);
    return this.candidates;
  }

  public async discard(webContentsId: number): Promise<boolean> {
    if (this.refuse.has(webContentsId)) return false;
    this.discarded.push(webContentsId);
    return true;
  }
}

const candidates = [
  { webContentsId: 1, lastUsedAt: 10 },
  { webContentsId: 2, lastUsedAt: 20 },
  { webContentsId: 3, lastUsedAt: 30 },
  { webContentsId: 4, lastUsedAt: 40 },
];

function discarderFor(
  level: number | undefined,
  lifecycle: FakeLifecycle,
  blocked: Set<number> = new Set(),
) {
  return new BrowserTabDiscarder({
    lifecycle,
    readPressureLevel: async () => level,
    isDiscardBlocked: (id) => blocked.has(id),
  });
}

describe("BrowserTabDiscarder", () => {
  test("does nothing while macOS reports normal pressure", async () => {
    for (const level of [undefined, 1]) {
      const lifecycle = new FakeLifecycle(candidates);
      expect(await discarderFor(level, lifecycle).check()).toBe(0);
      expect(lifecycle.askedIdleMs).toEqual([]);
    }
  });

  test("under a warning discards at most two tabs unused for an hour, oldest first", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    expect(await discarderFor(2, lifecycle).check()).toBe(2);
    expect(lifecycle.askedIdleMs).toEqual([BROWSER_TAB_DISCARD_AFTER_IDLE_MS]);
    expect(lifecycle.discarded).toEqual([1, 2]);
  });

  test("under critical pressure discards every eligible tab unused for 30 minutes", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    expect(await discarderFor(4, lifecycle).check()).toBe(4);
    expect(lifecycle.askedIdleMs).toEqual([BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS]);
  });

  test("skips protected tabs and tabs the lifecycle refuses, then moves on", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    lifecycle.refuse.add(2);
    expect(await discarderFor(2, lifecycle, new Set([1])).check()).toBe(2);
    expect(lifecycle.discarded).toEqual([3, 4]);
  });

  test("reports a failing pressure read instead of throwing", async () => {
    const errors: unknown[] = [];
    const discarder = new BrowserTabDiscarder({
      lifecycle: new FakeLifecycle(candidates),
      readPressureLevel: async () => {
        throw new Error("sysctl missing");
      },
      isDiscardBlocked: () => false,
      onError: (error) => errors.push(error),
    });
    expect(await discarder.check()).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

describe("edit detection", () => {
  test("counts text-editing keys, IME composition included, and ignores navigation keys", () => {
    for (const key of ["a", "ㄱ", "Process", "Backspace", "Delete", "Enter", "v"]) {
      expect(isEditingKeyInput({ type: "keyDown", key })).toBe(true);
    }
    for (const key of ["Tab", "ArrowDown", "PageUp", "Escape", "Meta", "F5", "F12"]) {
      expect(isEditingKeyInput({ type: "keyDown", key })).toBe(false);
    }
    expect(isEditingKeyInput({ type: "keyUp", key: "a" })).toBe(false);
  });

  test("marks agent commands that can leave unsaved input, not reads or navigation", () => {
    for (const command of ["fill", "type", "keypress", "select", "upload", "evaluate"]) {
      expect(BROWSER_AUTOMATION_EDITING_COMMANDS.has(command)).toBe(true);
    }
    for (const command of ["snapshot", "screenshot", "navigate", "read", "click", "list_tabs"]) {
      expect(BROWSER_AUTOMATION_EDITING_COMMANDS.has(command)).toBe(false);
    }
  });
});
