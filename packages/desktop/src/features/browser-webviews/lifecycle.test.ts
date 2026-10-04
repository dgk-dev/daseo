import { describe, expect, test } from "vitest";
import {
  BROWSER_TAB_FREEZE_AFTER_MS,
  BROWSER_TAB_THROTTLE_AFTER_MS,
  BrowserTabLifecycle,
  type BrowserTabLifecycleTarget,
} from "./lifecycle.js";

class FakeTab implements BrowserTabLifecycleTarget {
  public readonly calls: string[] = [];
  public loading = false;
  public audible = false;
  public destroyed = false;
  public pendingFreeze: (() => void) | null = null;
  public holdFreezes = false;

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isLoading(): boolean {
    return this.loading;
  }

  public isCurrentlyAudible(): boolean {
    return this.audible;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.calls.push(`throttling:${allowed}`);
  }

  public async setWebLifecycleState(state: "active" | "frozen"): Promise<void> {
    if (state === "frozen" && this.holdFreezes) {
      await new Promise<void>((resolve) => {
        this.pendingFreeze = resolve;
      });
    }
    this.calls.push(`lifecycle:${state}`);
  }
}

class FakeClock {
  public nowMs = 1_000_000;
  private timers: Array<{ at: number; callback: () => void; handle: number }> = [];
  private nextHandle = 1;

  public now = (): number => this.nowMs;

  public setTimer = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const handle = this.nextHandle++;
    this.timers.push({ at: this.nowMs + delayMs, callback, handle });
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  public clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter((timer) => timer.handle !== (handle as unknown as number));
  };

  public async advance(ms: number): Promise<void> {
    const until = this.nowMs + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= until)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.callback();
      await settle();
    }
    this.nowMs = until;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function createLifecycle(options: { blocked?: (id: number) => boolean } = {}) {
  const clock = new FakeClock();
  const errors: unknown[] = [];
  const lifecycle = new BrowserTabLifecycle({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isFreezeBlocked: options.blocked,
    onError: (error) => errors.push(error),
  });
  return { clock, lifecycle, errors };
}

describe("BrowserTabLifecycle", () => {
  test("steps an unused tab down to throttled, then frozen", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    expect(lifecycle.getState(1)).toBe("active");
    expect(tab.calls).toEqual(["throttling:false"]);

    await clock.advance(BROWSER_TAB_THROTTLE_AFTER_MS);
    expect(lifecycle.getState(1)).toBe("throttled");
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS - BROWSER_TAB_THROTTLE_AFTER_MS);
    expect(lifecycle.getState(1)).toBe("frozen");
    expect(tab.calls).toEqual(["throttling:false", "throttling:true", "lifecycle:frozen"]);
  });

  test("wake restores a frozen tab with lifecycle active before throttling off", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);
    tab.calls.length = 0;

    await lifecycle.wake(1);

    expect(lifecycle.getState(1)).toBe("active");
    expect(tab.calls).toEqual(["lifecycle:active", "throttling:false"]);
  });

  test("a held tab never steps down, and counts down from its release", async () => {
    const { clock, lifecycle } = createLifecycle();
    lifecycle.track(new FakeTab(1));
    const release = lifecycle.hold(1);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS * 2);
    expect(lifecycle.getState(1)).toBe("active");

    release();
    release();
    await clock.advance(BROWSER_TAB_THROTTLE_AFTER_MS - 1);
    expect(lifecycle.getState(1)).toBe("active");
    await clock.advance(1);
    expect(lifecycle.getState(1)).toBe("throttled");
  });

  test("runAwake wakes a frozen tab before the task and holds it during the task", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);

    const result = await lifecycle.runAwake(1, async () => {
      expect(lifecycle.getState(1)).toBe("active");
      await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);
      expect(lifecycle.getState(1)).toBe("active");
      return "done";
    });

    expect(result).toBe("done");
  });

  test("a wake that arrives during an in-flight freeze lands after it", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    tab.holdFreezes = true;
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);
    expect(tab.pendingFreeze).not.toBeNull();

    const woken = lifecycle.wake(1);
    tab.pendingFreeze?.();
    await woken;

    expect(tab.calls.slice(-3)).toEqual([
      "lifecycle:frozen",
      "lifecycle:active",
      "throttling:false",
    ]);
    expect(lifecycle.getState(1)).toBe("active");
  });

  test.each([
    ["loading", (tab: FakeTab) => (tab.loading = true)],
    ["audible", (tab: FakeTab) => (tab.audible = true)],
  ])("a %s tab is throttled but not frozen", async (_label, exempt) => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    exempt(tab);
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS * 3);
    expect(lifecycle.getState(1)).toBe("throttled");

    tab.loading = false;
    tab.audible = false;
    await clock.advance(60_000);
    expect(lifecycle.getState(1)).toBe("frozen");
  });

  test("an external exemption such as a download keeps the tab unfrozen", async () => {
    let downloading = true;
    const { clock, lifecycle } = createLifecycle({ blocked: () => downloading });
    lifecycle.track(new FakeTab(1));
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS * 2);
    expect(lifecycle.getState(1)).toBe("throttled");
    downloading = false;
    await clock.advance(60_000);
    expect(lifecycle.getState(1)).toBe("frozen");
  });

  test("turning the lifecycle off wakes every tab and keeps it active", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);

    lifecycle.setEnabled(false);
    await settle();
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS * 2);

    expect(lifecycle.getState(1)).toBe("active");
    expect(tab.calls.slice(-2)).toEqual(["lifecycle:active", "throttling:false"]);
  });

  test("a failed wake keeps the tab frozen so the next wake retries", async () => {
    const { clock, lifecycle, errors } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);
    const original = tab.setWebLifecycleState.bind(tab);
    tab.setWebLifecycleState = async () => {
      throw new Error("debugger unavailable");
    };

    await lifecycle.wake(1);
    expect(lifecycle.getState(1)).toBe("frozen");
    expect(errors).toHaveLength(1);

    tab.setWebLifecycleState = original;
    await lifecycle.wake(1);
    expect(lifecycle.getState(1)).toBe("active");
  });

  test("an untracked or destroyed tab is ignored", async () => {
    const { clock, lifecycle } = createLifecycle();
    const tab = new FakeTab(1);
    lifecycle.track(tab);
    tab.destroyed = true;
    await clock.advance(BROWSER_TAB_FREEZE_AFTER_MS);
    expect(tab.calls).toEqual(["throttling:false"]);
    lifecycle.untrack(1);
    await expect(lifecycle.wake(1)).resolves.toBeUndefined();
    expect(lifecycle.getState(1)).toBeNull();
  });
});
