import { useSyncExternalStore } from "react";

/**
 * Daseo: one timer for every spinner and elapsed time in the subagents track. Spinner frames
 * advance every 100 ms and the clock every second, both read from the same interval, which runs
 * only while something subscribes: at 100 ms while a spinner is on screen, at 1 s when only
 * elapsed times are (collapsed track, reduce motion). No row owns a timer.
 */
export const TRACK_SPINNER_FRAME_MS = 100;
const SECOND_MS = 1000;

type Listener = () => void;

export interface TrackClock {
  subscribeFrame(listener: Listener): () => void;
  subscribeSecond(listener: Listener): () => void;
  getFrame(): number;
  getSecond(): number;
}

export function createTrackClock(deps: {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}): TrackClock {
  const frameListeners = new Set<Listener>();
  const secondListeners = new Set<Listener>();
  let handle: unknown = null;
  let intervalMs = 0;
  let frame = Math.floor(deps.now() / TRACK_SPINNER_FRAME_MS);
  let second = Math.floor(deps.now() / SECOND_MS);

  const tick = () => {
    const now = deps.now();
    const nextFrame = Math.floor(now / TRACK_SPINNER_FRAME_MS);
    const nextSecond = Math.floor(now / SECOND_MS);
    if (nextFrame !== frame) {
      frame = nextFrame;
      for (const listener of frameListeners) listener();
    }
    if (nextSecond !== second) {
      second = nextSecond;
      for (const listener of secondListeners) listener();
    }
  };

  const reschedule = () => {
    let wanted = 0;
    if (frameListeners.size > 0) wanted = TRACK_SPINNER_FRAME_MS;
    else if (secondListeners.size > 0) wanted = SECOND_MS;
    if (wanted === intervalMs) return;
    if (handle !== null) deps.clearInterval(handle);
    handle = null;
    intervalMs = wanted;
    if (wanted > 0) {
      // A fresh subscriber reads the current time, not the value from before the timer slept.
      frame = Math.floor(deps.now() / TRACK_SPINNER_FRAME_MS);
      second = Math.floor(deps.now() / SECOND_MS);
      handle = deps.setInterval(tick, wanted);
    }
  };

  const subscribeTo = (listeners: Set<Listener>) => (listener: Listener) => {
    listeners.add(listener);
    reschedule();
    return () => {
      listeners.delete(listener);
      reschedule();
    };
  };

  return {
    subscribeFrame: subscribeTo(frameListeners),
    subscribeSecond: subscribeTo(secondListeners),
    // Stable between ticks, as a store snapshot must be. While the timer sleeps they are old;
    // the first subscriber refreshes them (see reschedule) and React re-reads the snapshot.
    getFrame: () => frame,
    getSecond: () => second,
  };
}

const trackClock = createTrackClock({
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
});

const subscribeNothing = () => () => {};

/** The spinner frame counter; frozen (no subscription, no timer) while `active` is false. */
export function useTrackSpinnerFrame(active: boolean): number {
  return useSyncExternalStore(
    active ? trackClock.subscribeFrame : subscribeNothing,
    trackClock.getFrame,
    trackClock.getFrame,
  );
}

/**
 * The clock's time in ms, advancing once a second while `active`. The value comes from the store
 * (not `Date.now()` in render), so the React Compiler sees it change and does not cache it.
 */
export function useTrackNow(active: boolean): number {
  const second = useSyncExternalStore(
    active ? trackClock.subscribeSecond : subscribeNothing,
    trackClock.getSecond,
    trackClock.getSecond,
  );
  return second * SECOND_MS;
}
