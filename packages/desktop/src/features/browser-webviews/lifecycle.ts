export type BrowserTabLifecycleState = "active" | "throttled" | "frozen";

/** The parts of a browser guest's WebContents the lifecycle drives. */
export interface BrowserTabLifecycleTarget {
  readonly id: number;
  isDestroyed(): boolean;
  isLoading(): boolean;
  isCurrentlyAudible(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  /** CDP `Page.setWebLifecycleState`. */
  setWebLifecycleState(state: "active" | "frozen"): Promise<void>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BrowserTabLifecycleOptions {
  enabled?: boolean;
  throttleAfterMs?: number;
  freezeAfterMs?: number;
  /** How soon to try again when a freeze-exempt tab (loading, audible, downloading) blocks it. */
  freezeRetryMs?: number;
  /** Freeze exemptions owned outside the tab: a download in progress, an active network capture. */
  isFreezeBlocked?: (webContentsId: number) => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (error: unknown, context: { webContentsId: number; step: string }) => void;
  onTransition?: (webContentsId: number, state: BrowserTabLifecycleState) => void;
}

interface TrackedTab {
  target: BrowserTabLifecycleTarget;
  state: BrowserTabLifecycleState;
  holds: number;
  lastUsedAt: number;
  timer: TimerHandle | null;
  steps: Promise<void>;
}

export const BROWSER_TAB_THROTTLE_AFTER_MS = 2 * 60_000;
export const BROWSER_TAB_FREEZE_AFTER_MS = 15 * 60_000;
const BROWSER_TAB_FREEZE_RETRY_MS = 60_000;

/**
 * Browser tabs stay resident so agents and phones can use them at any time, which used to mean
 * every parked tab ran at full speed forever: background throttling was off from attach so
 * captures and automation never met a sleeping page. Now each tab steps down while nobody uses
 * it, the way Edge sleeping tabs and VS Code's retained webviews do, and wakes before anyone does:
 *
 * - active: presented in a pane, held by a command, capture, or phone stream, or used in the last
 *   two minutes. Background throttling off, as before.
 * - throttled: two minutes unused. Chromium background throttling on (timers ~1 Hz, no rAF).
 * - frozen: fifteen minutes unused. CDP `Page.setWebLifecycleState frozen` stops script and
 *   rendering entirely; memory stays, so page state survives and macOS compresses it.
 *
 * `wake` returns a tab to active in one CDP round trip: `active` first, then throttling off —
 * an active page left throttled stays at 1 Hz timers. A loading, audible, or downloading tab is
 * throttled but never frozen. Every transition runs on the tab's own serial chain, so a wake that
 * arrives while a freeze is in flight is applied after it, never before.
 */
export class BrowserTabLifecycle {
  private enabled: boolean;
  private readonly tabs = new Map<number, TrackedTab>();
  private readonly throttleAfterMs: number;
  private readonly freezeAfterMs: number;
  private readonly freezeRetryMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  public constructor(private readonly options: BrowserTabLifecycleOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.throttleAfterMs = options.throttleAfterMs ?? BROWSER_TAB_THROTTLE_AFTER_MS;
    this.freezeAfterMs = options.freezeAfterMs ?? BROWSER_TAB_FREEZE_AFTER_MS;
    this.freezeRetryMs = options.freezeRetryMs ?? BROWSER_TAB_FREEZE_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Turning the lifecycle off wakes every tab and keeps them all active: the pre-lifecycle
   * behavior, background throttling off from attach to destroy.
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    for (const tab of this.tabs.values()) {
      this.cancelTimer(tab);
      tab.lastUsedAt = this.now();
      void this.enqueue(tab, "enable", async () => {
        await this.activate(tab);
        if (this.enabled) this.scheduleIdle(tab);
      });
    }
  }

  public track(target: BrowserTabLifecycleTarget): void {
    if (this.tabs.has(target.id)) {
      return;
    }
    const tab: TrackedTab = {
      target,
      state: "active",
      holds: 0,
      lastUsedAt: this.now(),
      timer: null,
      steps: Promise.resolve(),
    };
    this.tabs.set(target.id, tab);
    this.call(tab, "attach", () => target.setBackgroundThrottling(false));
    this.scheduleIdle(tab);
  }

  public untrack(webContentsId: number): void {
    const tab = this.tabs.get(webContentsId);
    if (!tab) {
      return;
    }
    this.cancelTimer(tab);
    this.tabs.delete(webContentsId);
  }

  public getState(webContentsId: number): BrowserTabLifecycleState | null {
    return this.tabs.get(webContentsId)?.state ?? null;
  }

  /** Marks the tab used and resolves once it runs at full speed. */
  public wake(webContentsId: number): Promise<void> {
    const tab = this.tabs.get(webContentsId);
    if (!tab) {
      return Promise.resolve();
    }
    tab.lastUsedAt = this.now();
    this.cancelTimer(tab);
    const woken = this.enqueue(tab, "wake", () => this.activate(tab));
    this.scheduleIdle(tab);
    return woken;
  }

  /** Keeps the tab active until the returned release runs; releasing twice is harmless. */
  public hold(webContentsId: number): () => void {
    const tab = this.tabs.get(webContentsId);
    if (!tab) {
      return () => {};
    }
    tab.holds += 1;
    void this.wake(webContentsId);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      tab.holds -= 1;
      tab.lastUsedAt = this.now();
      this.scheduleIdle(tab);
    };
  }

  /** Runs `task` with the tab held and awake: every automation command and capture. */
  public async runAwake<T>(webContentsId: number, task: () => Promise<T>): Promise<T> {
    const release = this.hold(webContentsId);
    try {
      await this.wake(webContentsId);
      return await task();
    } finally {
      release();
    }
  }

  private async activate(tab: TrackedTab): Promise<void> {
    if (tab.state === "frozen") {
      await tab.target.setWebLifecycleState("active");
    }
    if (tab.state !== "active") {
      tab.target.setBackgroundThrottling(false);
      this.setState(tab, "active");
    }
  }

  private scheduleIdle(tab: TrackedTab): void {
    this.cancelTimer(tab);
    if (!this.enabled || tab.holds > 0 || !this.tabs.has(tab.target.id)) {
      return;
    }
    if (tab.state === "active") {
      this.armTimer(tab, tab.lastUsedAt + this.throttleAfterMs - this.now(), () =>
        this.enqueue(tab, "throttle", async () => this.throttle(tab)),
      );
    } else if (tab.state === "throttled") {
      this.armTimer(tab, tab.lastUsedAt + this.freezeAfterMs - this.now(), () =>
        this.enqueue(tab, "freeze", () => this.freeze(tab)),
      );
    }
  }

  private throttle(tab: TrackedTab): void {
    if (!this.isIdleFor(tab, this.throttleAfterMs) || tab.state !== "active") {
      this.scheduleIdle(tab);
      return;
    }
    tab.target.setBackgroundThrottling(true);
    this.setState(tab, "throttled");
    this.scheduleIdle(tab);
  }

  private async freeze(tab: TrackedTab): Promise<void> {
    if (!this.isIdleFor(tab, this.freezeAfterMs) || tab.state !== "throttled") {
      this.scheduleIdle(tab);
      return;
    }
    if (
      tab.target.isLoading() ||
      tab.target.isCurrentlyAudible() ||
      this.options.isFreezeBlocked?.(tab.target.id) === true
    ) {
      this.armTimer(tab, this.freezeRetryMs, () =>
        this.enqueue(tab, "freeze", () => this.freeze(tab)),
      );
      return;
    }
    await tab.target.setWebLifecycleState("frozen");
    this.setState(tab, "frozen");
  }

  private setState(tab: TrackedTab, state: BrowserTabLifecycleState): void {
    tab.state = state;
    this.options.onTransition?.(tab.target.id, state);
  }

  private isIdleFor(tab: TrackedTab, durationMs: number): boolean {
    return (
      this.enabled &&
      tab.holds === 0 &&
      this.tabs.get(tab.target.id) === tab &&
      this.now() - tab.lastUsedAt >= durationMs
    );
  }

  private enqueue(tab: TrackedTab, step: string, run: () => Promise<void> | void): Promise<void> {
    const next = tab.steps.then(() => this.runStep(tab, step, run));
    tab.steps = next;
    return next;
  }

  private async runStep(
    tab: TrackedTab,
    step: string,
    run: () => Promise<void> | void,
  ): Promise<void> {
    if (tab.target.isDestroyed()) {
      return;
    }
    try {
      await run();
    } catch (error) {
      this.options.onError?.(error, { webContentsId: tab.target.id, step });
    }
  }

  private call(tab: TrackedTab, step: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.onError?.(error, { webContentsId: tab.target.id, step });
    }
  }

  private armTimer(tab: TrackedTab, delayMs: number, fire: () => unknown): void {
    this.cancelTimer(tab);
    tab.timer = this.setTimer(
      () => {
        tab.timer = null;
        void fire();
      },
      Math.max(0, delayMs),
    );
    (tab.timer as { unref?: () => void }).unref?.();
  }

  private cancelTimer(tab: TrackedTab): void {
    if (tab.timer !== null) {
      this.clearTimer(tab.timer);
      tab.timer = null;
    }
  }
}
