/**
 * Daseo delta 86: decides when the native app drops its daemon connections.
 *
 * The app stops being visible -> after a grace period every host connection is suspended, so a
 * phone with the screen off stops receiving and rendering the live agent stream. The grace keeps
 * quick trips out of the app (a permission or credential prompt, copying a code) free of
 * reconnects. Showing the app again resumes at once. A hold (a dictation or voice session in
 * progress) defers the suspend until it is released.
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
}): BackgroundSuspendController {
  const { target, scheduler } = input;
  const graceMs = input.graceMs ?? BACKGROUND_SUSPEND_GRACE_MS;
  const holds = new Set<symbol>();
  let visible = input.initiallyVisible;
  let suspended = false;
  let graceElapsed = false;
  let cancelGrace: (() => void) | null = null;
  let disposed = false;

  function maybeSuspend(): void {
    if (disposed || visible || suspended || !graceElapsed || holds.size > 0) {
      return;
    }
    suspended = true;
    target.setBackgroundSuspended(true);
  }

  function armGrace(): void {
    cancelGrace = scheduler.schedule(graceMs, () => {
      cancelGrace = null;
      graceElapsed = true;
      maybeSuspend();
    });
  }

  function disarmGrace(): void {
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
      if (visible) {
        if (suspended) {
          suspended = false;
          target.setBackgroundSuspended(false);
        }
        return;
      }
      armGrace();
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
