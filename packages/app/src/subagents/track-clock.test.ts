import { describe, expect, it } from "vitest";
import { createTrackClock } from "./track-clock";

function harness() {
  let now = 10_000;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextId = 1;
  const clock = createTrackClock({
    now: () => now,
    setInterval: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    clock,
    timers,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.values()) timer.callback();
    },
  };
}

describe("track clock", () => {
  it("runs no timer without subscribers", () => {
    const { timers } = harness();
    expect(timers.size).toBe(0);
  });

  it("shares one 100 ms timer between every spinner and elapsed time", () => {
    const { clock, timers, advance } = harness();
    let frames = 0;
    let seconds = 0;
    const offA = clock.subscribeFrame(() => frames++);
    const offB = clock.subscribeFrame(() => frames++);
    const offSecond = clock.subscribeSecond(() => seconds++);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([100]);

    advance(100);
    expect(frames).toBe(2);
    expect(seconds).toBe(0);
    advance(900);
    expect(seconds).toBe(1);

    offA();
    offB();
    // Only elapsed times left (collapsed track or reduce motion): once a second is enough.
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([1000]);
    offSecond();
    expect(timers.size).toBe(0);
  });

  it("never advances a spinner frame faster than every 100 ms", () => {
    const { clock, advance } = harness();
    let frames = 0;
    clock.subscribeFrame(() => frames++);
    const before = clock.getFrame();
    advance(40);
    expect(frames).toBe(0);
    advance(60);
    expect(frames).toBe(1);
    expect(clock.getFrame()).toBe(before + 1);
  });
});
