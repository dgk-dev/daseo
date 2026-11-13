import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { BROWSER_TAB_RESTORE_WAIT_MS } from "./lifecycle.js";
import {
  restoreDiscardedBrowserContents,
  type BrowserRestoreClock,
  type ReloadableBrowserContents,
} from "./restore.js";

class FakeContents extends EventEmitter implements ReloadableBrowserContents {
  public reloads = 0;
  public crashed = true;
  public destroyed = false;
  /** What each reload does once issued; by default nothing until the test emits. */
  public onReload: (reloadIndex: number) => void = () => {};

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isCrashed(): boolean {
    return this.crashed;
  }

  public reload(): void {
    this.reloads += 1;
    this.onReload(this.reloads);
  }
}

class FakeClock implements BrowserRestoreClock {
  public nowMs = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextHandle = 1;

  public now(): number {
    return this.nowMs;
  }

  public setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.nowMs + delayMs, callback });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  public clearTimer(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  public async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    for (const [handle, timer] of this.timers) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(handle);
        timer.callback();
      }
    }
    await settle();
  }

  public pendingTimers(): number {
    return this.timers.size;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function track(promise: Promise<void>): { done: boolean; error: unknown } {
  const state: { done: boolean; error: unknown } = { done: false, error: null };
  void (async () => {
    try {
      await promise;
    } catch (error) {
      state.error = error;
    }
    state.done = true;
  })();
  return state;
}

describe("restoreDiscardedBrowserContents", () => {
  test("resolves when the reloaded document is ready, not when the whole load stops", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    const restored = track(restoreDiscardedBrowserContents(contents, { clock }));
    await settle();
    expect(contents.reloads).toBe(1);
    await clock.advance(1_000);
    expect(restored.done).toBe(false);

    contents.crashed = false;
    contents.emit("dom-ready");
    await settle();

    expect(restored).toEqual({ done: true, error: null });
    expect(contents.listenerCount("dom-ready")).toBe(0);
    expect(contents.listenerCount("did-stop-loading")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a load that fails before dom-ready still ends the wait", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    contents.onReload = () => {
      contents.crashed = false;
      queueMicrotask(() => contents.emit("did-stop-loading"));
    };
    await restoreDiscardedBrowserContents(contents, { clock });
    expect(contents.reloads).toBe(1);
  });

  test("a page still loading at the 15 s cap has a live renderer and counts as restored", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    contents.onReload = () => {
      contents.crashed = false;
    };
    const restored = track(restoreDiscardedBrowserContents(contents, { clock }));
    await clock.advance(BROWSER_TAB_RESTORE_WAIT_MS - 1);
    expect(restored.done).toBe(false);
    await clock.advance(1);
    expect(restored).toEqual({ done: true, error: null });
    expect(contents.reloads).toBe(1);
  });

  test("a renderer still crashed is reloaded once more inside the same budget", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    contents.onReload = (reloadIndex) => {
      if (reloadIndex === 2) contents.crashed = false;
      queueMicrotask(() => contents.emit("did-stop-loading"));
    };
    await restoreDiscardedBrowserContents(contents, { clock });
    expect(contents.reloads).toBe(2);
  });

  test("a renderer that never comes back within the budget throws so the next wake retries", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    const restored = track(restoreDiscardedBrowserContents(contents, { clock }));
    await clock.advance(BROWSER_TAB_RESTORE_WAIT_MS);
    // The first reload used the whole budget, so no second attempt starts.
    expect(contents.reloads).toBe(1);
    expect(String(restored.error)).toContain("did not come back");
  });

  test("a tab closed during the reload ends the wait without an error", async () => {
    const clock = new FakeClock();
    const contents = new FakeContents();
    const restored = track(restoreDiscardedBrowserContents(contents, { clock }));
    await settle();
    contents.destroyed = true;
    contents.emit("destroyed");
    await settle();
    expect(restored).toEqual({ done: true, error: null });
  });
});
