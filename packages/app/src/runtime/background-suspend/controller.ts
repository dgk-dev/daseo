/**
 * Daseo delta 86: decides when the native app drops its daemon connections.
 *
 * The app stops being visible -> after a grace period every host connection is suspended, so a
 * phone with the screen off stops receiving and rendering the live agent stream. The grace keeps
 * quick trips out of the app (a permission or credential prompt, copying a code) free of
 * reconnects. Showing the app again resumes at once. A hold (a dictation or voice session in
 * progress) defers the suspend until it is released.
 *
 * The grace timer counts awake, unfrozen time only (Android's main-looper `postDelayed` stops in
 * deep sleep and does not run while the process is frozen), so it can still be pending when the
 * app returns long after the grace. The return is judged by the wall clock instead: away for the
 * whole grace means the connections are stale by this contract and are cycled once; a shorter
 * absence asks for a liveness check, which keeps a healthy socket and replaces a dead one.
 */

export const BACKGROUND_SUSPEND_GRACE_MS = 30_000;

export interface BackgroundSuspendScheduler {
  /**
   * Runs `callback` once after `delayMs`. Must keep running while the native host is paused:
   * React Native's JS timers do not. Returns a cancel function.
   */
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface BackgroundSuspendTarget {
  setBackgroundSuspended(suspended: boolean): void;
  /**
   * Drops and reopens every host connection once, as a suspend followed by a resume, for an app
   * that was away for the whole grace while the timer never fired. No memory release: the app is
   * on screen.
   */
  cycleConnections(): void;
  /** Checks that every connected host still answers, replacing a socket that died silently. */
  verifyConnections(): void;
}

/**
 * Daseo delta 140: what the controller did, for the return breadcrumbs. `awayMs` is wall-clock
 * time since the app left the screen.
 */
export interface BackgroundSuspendTransition {
  kind: "suspend" | "resume" | "cycle" | "verify";
  awayMs: number;
}

export interface BackgroundSuspendController {
  setVisible(visible: boolean): void;
  /** Keeps the connection while the returned release function has not been called. */
  hold(): () => void;
  isSuspended(): boolean;
  dispose(): void;
}

export function createBackgroundSuspendController(input: {
  target: BackgroundSuspendTarget;
  scheduler: BackgroundSuspendScheduler;
  initiallyVisible: boolean;
  graceMs?: number;
  /** Wall clock: keeps counting through device sleep and a frozen process. */
  now?: () => number;
  onTransition?: (transition: BackgroundSuspendTransition) => void;
}): BackgroundSuspendController {
  const { target, scheduler } = input;
  const graceMs = input.graceMs ?? BACKGROUND_SUSPEND_GRACE_MS;
  const now = input.now ?? Date.now;
  const holds = new Set<symbol>();
  let visible = input.initiallyVisible;
  let hiddenAt: number | null = visible ? null : now();
  let suspended = false;
  let graceElapsed = false;
  let graceGeneration = 0;
  let cancelGrace: (() => void) | null = null;
  let disposed = false;

  function maybeSuspend(): void {
    if (disposed || visible || suspended || !graceElapsed || holds.size > 0) {
      return;
    }
    suspended = true;
    target.setBackgroundSuspended(true);
    input.onTransition?.({ kind: "suspend", awayMs: hiddenAt === null ? 0 : now() - hiddenAt });
  }

  function armGrace(): void {
    const generation = ++graceGeneration;
    cancelGrace = scheduler.schedule(graceMs, () => {
      // A timer event already queued when its grace was cancelled must not end a later one.
      if (generation !== graceGeneration) {
        return;
      }
      cancelGrace = null;
      graceElapsed = true;
      maybeSuspend();
    });
  }

  function disarmGrace(): void {
    graceGeneration += 1;
    cancelGrace?.();
    cancelGrace = null;
    graceElapsed = false;
  }

  if (!visible) {
    armGrace();
  }

  return {
    setVisible(nextVisible) {
      if (disposed || nextVisible === visible) {
        return;
      }
      visible = nextVisible;
      disarmGrace();
      if (!visible) {
        hiddenAt = now();
        armGrace();
        return;
      }
      const awayMs = hiddenAt === null ? 0 : now() - hiddenAt;
      hiddenAt = null;
      if (suspended) {
        suspended = false;
        target.setBackgroundSuspended(false);
        input.onTransition?.({ kind: "resume", awayMs });
        return;
      }
      // A hold kept the connection on purpose (a recording streams over it): never cut it.
      if (awayMs >= graceMs && holds.size === 0) {
        target.cycleConnections();
        input.onTransition?.({ kind: "cycle", awayMs });
        return;
      }
      target.verifyConnections();
      input.onTransition?.({ kind: "verify", awayMs });
    },
    hold() {
      const token = Symbol("background-suspend-hold");
      holds.add(token);
      return () => {
        if (holds.delete(token)) {
          maybeSuspend();
        }
      };
    },
    isSuspended() {
      return suspended;
    },
    dispose() {
      disposed = true;
      disarmGrace();
      holds.clear();
    },
  };
}
