/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ring clock runs on the UI runtime. Here that runtime is the test itself: shared values are
// plain boxes with listeners, scheduleOnUI runs synchronously and frames advance by hand.
vi.mock("react-native-reanimated", () => {
  function makeMutable<T>(initial: T) {
    const listeners = new Map<number, (value: T) => void>();
    let current = initial;
    return {
      get value() {
        return current;
      },
      set value(next: T) {
        current = next;
        for (const listener of listeners.values()) listener(next);
      },
      addListener: (id: number, listener: (value: T) => void) => listeners.set(id, listener),
      removeListener: (id: number) => listeners.delete(id),
    };
  }
  return {
    makeMutable,
    useSharedValue: <T>(initial: T) => useState(() => makeMutable(initial))[0],
  };
});
vi.mock("react-native-worklets", () => ({
  scheduleOnUI: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

let pendingFrames: Array<() => void> = [];
let now = 0;

function runFrame(atMs: number): void {
  now = atMs;
  const frames = pendingFrames;
  pendingFrames = [];
  for (const frame of frames) frame();
}

beforeEach(() => {
  pendingFrames = [];
  now = 900;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    pendingFrames.push(callback);
    return pendingFrames.length;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The test resolver prefers clock.web.ts (the browser implementation) for "./clock"; this path
// names the native module, which is what TypeScript's "./clock" types describe.
const NATIVE_CLOCK_MODULE = "./clock.ts";

async function loadClock(): Promise<typeof import("./clock")> {
  vi.resetModules();
  return import(/* @vite-ignore */ NATIVE_CLOCK_MODULE);
}

describe("status ring clock", () => {
  it("turns a ring on screen in step with the shared clock", async () => {
    const { useStatusRingRotation } = await loadClock();
    const { result } = renderHook(() => useStatusRingRotation(true, false));

    expect(pendingFrames).toHaveLength(1);
    act(() => runFrame(1_125));

    expect(result.current.value).toBe(90);
  });

  it("does not run the clock for a ring in a hidden panel", async () => {
    const { useStatusRingRotation } = await loadClock();
    const { result } = renderHook(() => useStatusRingRotation(false, false));
    const before = result.current.value;

    expect(pendingFrames).toHaveLength(0);
    act(() => runFrame(1_125));
    expect(result.current.value).toBe(before);
  });

  it("keeps the ring still under reduce motion", async () => {
    const { STATIC_STATUS_RING_ROTATION, useStatusRingRotation } = await loadClock();
    const { result } = renderHook(() => useStatusRingRotation(true, true));

    expect(pendingFrames).toHaveLength(0);
    expect(result.current.value).toBe(STATIC_STATUS_RING_ROTATION);
  });

  it("detaches a ring whose panel hides and stops the clock with the last visible ring", async () => {
    const { useStatusRingRotation } = await loadClock();
    const visible = renderHook(({ active }) => useStatusRingRotation(active, false), {
      initialProps: { active: true },
    });
    const other = renderHook(() => useStatusRingRotation(true, false));

    act(() => runFrame(1_125));
    expect(visible.result.current.value).toBe(90);

    visible.rerender({ active: false });
    act(() => runFrame(1_350));
    expect(visible.result.current.value).toBe(90);
    expect(other.result.current.value).toBe(180);

    other.unmount();
    act(() => runFrame(1_575));
    expect(pendingFrames).toHaveLength(0);
  });
});
