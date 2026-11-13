import { BROWSER_TAB_RESTORE_WAIT_MS } from "./lifecycle.js";

/** What reloading a discarded tab needs from its WebContents. */
export interface ReloadableBrowserContents {
  isDestroyed(): boolean;
  isCrashed(): boolean;
  reload(): void;
  on(event: "dom-ready" | "did-stop-loading", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(
    event: "dom-ready" | "did-stop-loading" | "destroyed",
    listener: () => void,
  ): unknown;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BrowserRestoreClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

const systemClock: BrowserRestoreClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
};

const BROWSER_TAB_RESTORE_ATTEMPTS = 2;

/**
 * Reloads a discarded tab in a new renderer and resolves once its document is ready (delta 97).
 * Before, the wake waited for the whole load to stop (up to 30 s) but the lifecycle step gave up
 * after 5 s, so the first command after a discard could run against a page still mid-load.
 * `dom-ready` is the point a snapshot, read, or click can see the page. The 10 s budget leaves the
 * command part of the daemon's 15 s deadline when the page is slower than that. One budget covers
 * both attempts: a renderer still crashed after the first reload is reloaded once more if time is
 * left. A page still loading at the deadline has a live renderer and counts as restored; a
 * renderer that never came back throws, leaving the tab discarded for the next wake to retry.
 */
export async function restoreDiscardedBrowserContents(
  contents: ReloadableBrowserContents,
  options: { waitMs?: number; clock?: BrowserRestoreClock } = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + (options.waitMs ?? BROWSER_TAB_RESTORE_WAIT_MS);
  for (let attempt = 0; attempt < BROWSER_TAB_RESTORE_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - clock.now();
    if (contents.isDestroyed() || remainingMs <= 0) {
      break;
    }
    await reloadUntilReady(contents, remainingMs, clock);
    if (contents.isDestroyed() || !contents.isCrashed()) {
      return;
    }
  }
  if (contents.isDestroyed()) {
    return;
  }
  throw new Error("browser tab renderer did not come back after reload");
}

async function reloadUntilReady(
  contents: ReloadableBrowserContents,
  waitMs: number,
  clock: BrowserRestoreClock,
): Promise<void> {
  // Settles on the first of: the document is ready, the load stopped (a failed load may never
  // reach dom-ready), the tab closed, or the time is up.
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timer = clock.setTimer(settle, waitMs);
  contents.on("dom-ready", settle);
  contents.on("did-stop-loading", settle);
  contents.once("destroyed", settle);
  try {
    contents.reload();
    await settled;
  } finally {
    clock.clearTimer(timer);
    contents.removeListener("dom-ready", settle);
    contents.removeListener("did-stop-loading", settle);
    contents.removeListener("destroyed", settle);
  }
}
