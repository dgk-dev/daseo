import { describe, expect, test } from "vitest";
import {
  BROWSER_AUTOMATION_EDITING_COMMANDS,
  BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS,
  BROWSER_TAB_DISCARD_AFTER_IDLE_MS,
  BROWSER_TAB_DISCARD_AFTER_IDLE_NORMAL_MS,
  BROWSER_TAB_DISCARD_SKIP_LOG_INTERVAL_MS,
  BrowserTabDiscarder,
  isEditingKeyInput,
  type BrowserTabDiscardBlockReason,
  type BrowserTabDiscardEvent,
  type BrowserTabDiscardSkip,
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

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;
const candidates = [
  { webContentsId: 1, lastUsedAt: NOW - 400 * MINUTE },
  { webContentsId: 2, lastUsedAt: NOW - 300 * MINUTE },
  { webContentsId: 3, lastUsedAt: NOW - 200 * MINUTE },
  { webContentsId: 4, lastUsedAt: NOW - 190 * MINUTE },
];

function discarderFor(
  level: number | undefined,
  lifecycle: FakeLifecycle,
  blocked: Map<number, BrowserTabDiscardBlockReason> = new Map(),
  options: { idleDiscardAfterMs?: number; now?: () => number } = {},
) {
  const discards: BrowserTabDiscardEvent[] = [];
  const skips: BrowserTabDiscardSkip[] = [];
  const discarder = new BrowserTabDiscarder({
    lifecycle,
    readPressureLevel: async () => level,
    isDiscardBlocked: (id) => blocked.get(id) ?? null,
    onDiscard: (event) => discards.push(event),
    onSkip: (skip) => skips.push(skip),
    now: options.now ?? (() => NOW),
    ...(options.idleDiscardAfterMs !== undefined
      ? { idleDiscardAfterMs: options.idleDiscardAfterMs }
      : {}),
  });
  return Object.assign(discarder, { discards, skips });
}

describe("BrowserTabDiscarder", () => {
  test("without memory pressure discards one tab unused for three hours per check, oldest first", async () => {
    for (const level of [undefined, 1]) {
      const lifecycle = new FakeLifecycle(candidates);
      const discarder = discarderFor(level, lifecycle);
      expect(await discarder.check()).toBe(1);
      expect(lifecycle.askedIdleMs).toEqual([BROWSER_TAB_DISCARD_AFTER_IDLE_NORMAL_MS]);
      expect(lifecycle.discarded).toEqual([1]);
      expect(discarder.discards).toEqual([
        { webContentsId: 1, idleMinutes: 400, trigger: { kind: "idle" } },
      ]);
    }
  });

  test("an idle time of 0 turns the discard without pressure off", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    const discarder = discarderFor(1, lifecycle, new Map(), { idleDiscardAfterMs: 0 });
    expect(await discarder.check()).toBe(0);
    expect(lifecycle.askedIdleMs).toEqual([]);

    discarder.setIdleDiscardAfterMs(5 * MINUTE);
    expect(await discarder.check()).toBe(1);
    expect(lifecycle.askedIdleMs).toEqual([5 * MINUTE]);
  });

  test("the idle discard goes through the same blocker check and moves past kept tabs", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    lifecycle.refuse.add(2);
    const blocked = new Map<number, BrowserTabDiscardBlockReason>([[1, "edited"]]);
    const discarder = discarderFor(undefined, lifecycle, blocked);
    expect(await discarder.check()).toBe(1);
    expect(lifecycle.discarded).toEqual([3]);
    expect(discarder.skips).toEqual([{ webContentsId: 1, idleMinutes: 400, reason: "edited" }]);
  });

  test("a kept candidate is reported once an hour, not on every check", async () => {
    let now = NOW;
    const lifecycle = new FakeLifecycle([candidates[0]]);
    const blocked = new Map<number, BrowserTabDiscardBlockReason>([[1, "shared-renderer"]]);
    const discarder = discarderFor(undefined, lifecycle, blocked, { now: () => now });
    // Checks every 30 s for one hour, both ends included: the first and the one an hour later.
    while (now <= NOW + BROWSER_TAB_DISCARD_SKIP_LOG_INTERVAL_MS) {
      await discarder.check();
      now += 30_000;
    }
    expect(discarder.skips.map((skip) => skip.reason)).toEqual([
      "shared-renderer",
      "shared-renderer",
    ]);
    expect(lifecycle.discarded).toEqual([]);
  });

  test("under a warning a shorter idle setting is kept, never lengthened by pressure", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    await discarderFor(2, lifecycle, new Map(), { idleDiscardAfterMs: 20 * MINUTE }).check();
    expect(lifecycle.askedIdleMs).toEqual([20 * MINUTE]);
  });

  test("under a warning discards at most two tabs unused for an hour, oldest first", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    const discarder = discarderFor(2, lifecycle);
    expect(await discarder.check()).toBe(2);
    expect(lifecycle.askedIdleMs).toEqual([BROWSER_TAB_DISCARD_AFTER_IDLE_MS]);
    expect(lifecycle.discarded).toEqual([1, 2]);
    expect(discarder.discards.map((event) => event.trigger)).toEqual([
      { kind: "pressure", pressureLevel: 2 },
      { kind: "pressure", pressureLevel: 2 },
    ]);
  });

  test("under critical pressure discards every eligible tab unused for 30 minutes", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    expect(await discarderFor(4, lifecycle).check()).toBe(4);
    expect(lifecycle.askedIdleMs).toEqual([BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS]);
  });

  test("skips protected tabs and tabs the lifecycle refuses, then moves on", async () => {
    const lifecycle = new FakeLifecycle(candidates);
    lifecycle.refuse.add(2);
    expect(await discarderFor(2, lifecycle, new Map([[1, "downloading"]])).check()).toBe(2);
    expect(lifecycle.discarded).toEqual([3, 4]);
  });

  test("reports a failing pressure read instead of throwing", async () => {
    const errors: unknown[] = [];
    const discarder = new BrowserTabDiscarder({
      lifecycle: new FakeLifecycle(candidates),
      readPressureLevel: async () => {
        throw new Error("sysctl missing");
      },
      isDiscardBlocked: () => null,
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
