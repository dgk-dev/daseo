import { useSyncExternalStore } from "react";
import { BRAILLE_SPINNER_FRAME_MS } from "@/components/braille-spinner/frames";

/**
 * Daseo: the one JS timer behind every braille spinner and every live elapsed time (the subagents
 * track's times, its header). Spinner frames advance every 100 ms and the seconds every second,
 * both read from the same interval, which runs only while something subscribes: at 100 ms while a
 * spinner frame is subscribed, at 1 s when only elapsed times are, and not at all while the
 * document is hidden. Nothing else in the app owns a spinner timer. On Android no spinner
 * subscribes here; the native view keeps its own single ticker (modules/daseo-braille-spinner).
 */
const SECOND_MS = 1000;

type Listener = () => void;

export interface UiClockVisibility {
  isHidden(): boolean;
  subscribe(listener: Listener): () => void;
}

export interface UiClock {
  subscribeFrame(listener: Listener): () => void;
  subscribeSecond(listener: Listener): () => void;
  getFrame(): number;
  getSecond(): number;
}

export function createUiClock(deps: {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  visibility?: UiClockVisibility;
}): UiClock {
  const frameListeners = new Set<Listener>();
  const secondListeners = new Set<Listener>();
  let handle: unknown = null;
  let intervalMs = 0;
  let frame = Math.floor(deps.now() / BRAILLE_SPINNER_FRAME_MS);
  let second = Math.floor(deps.now() / SECOND_MS);
  let unsubscribeVisibility: (() => void) | null = null;

  const tick = () => {
    const now = deps.now();
    const nextFrame = Math.floor(now / BRAILLE_SPINNER_FRAME_MS);
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
    const hasListeners = frameListeners.size > 0 || secondListeners.size > 0;
    if (hasListeners && deps.visibility && unsubscribeVisibility === null) {
      unsubscribeVisibility = deps.visibility.subscribe(onVisibilityChange);
    } else if (!hasListeners && unsubscribeVisibility !== null) {
      unsubscribeVisibility();
      unsubscribeVisibility = null;
    }
    let wanted = 0;
    if (deps.visibility?.isHidden()) wanted = 0;
    else if (frameListeners.size > 0) wanted = BRAILLE_SPINNER_FRAME_MS;
    else if (secondListeners.size > 0) wanted = SECOND_MS;
    if (wanted === intervalMs) return;
    if (handle !== null) deps.clearInterval(handle);
    handle = null;
    intervalMs = wanted;
    if (wanted > 0) {
      // A fresh subscriber, or a document that came back, reads the current time, not the value
      // from before the timer slept.
      tick();
      handle = deps.setInterval(tick, wanted);
    }
  };

  function onVisibilityChange() {
    reschedule();
  }

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

function documentVisibility(): UiClockVisibility | undefined {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return undefined;
  }
  return {
    isHidden: () => document.visibilityState === "hidden",
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export const uiClock = createUiClock({
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  visibility: documentVisibility(),
});

const subscribeNothing = () => () => {};

/** The absolute spinner frame counter; frozen (no subscription, no timer) while `active` is false. */
export function useSpinnerFrame(active: boolean): number {
  return useSyncExternalStore(
    active ? uiClock.subscribeFrame : subscribeNothing,
    uiClock.getFrame,
    uiClock.getFrame,
  );
}

/**
 * The clock's time in ms, advancing once a second while `active`. The value comes from the store
 * (not `Date.now()` in render), so the React Compiler sees it change and does not cache it.
 */
export function useClockNow(active: boolean): number {
  const second = useSyncExternalStore(
    active ? uiClock.subscribeSecond : subscribeNothing,
    uiClock.getSecond,
    uiClock.getSecond,
  );
  return second * SECOND_MS;
}
