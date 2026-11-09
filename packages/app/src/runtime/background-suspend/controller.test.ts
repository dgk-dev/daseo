import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SUSPEND_GRACE_MS,
  createBackgroundSuspendController,
  type BackgroundSuspendScheduler,
} from "./controller";

// Stands in for the native Android timer: fires only when the test advances it.
function createManualScheduler() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  const scheduler: BackgroundSuspendScheduler = {
    schedule(delayMs, callback) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
  return {
    scheduler,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      // Snapshot first: a callback may schedule the next timer.
      for (const [id, timer] of Array.from(timers.entries())) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

function createTarget() {
  const calls: boolean[] = [];
  return { calls, setBackgroundSuspended: (suspended: boolean) => calls.push(suspended) };
}

function setup(initiallyVisible = true) {
  const clock = createManualScheduler();
  const target = createTarget();
  const controller = createBackgroundSuspendController({
    target,
    scheduler: clock.scheduler,
    initiallyVisible,
  });
  return { clock, target, controller };
}

describe("background suspend controller", () => {
  it("uses a 30 second grace", () => {
    expect(BACKGROUND_SUSPEND_GRACE_MS).toBe(30_000);
  });

  it("suspends once the app has been out of view for the whole grace", () => {
    const { clock, target, controller } = setup();

    controller.setVisible(false);
    clock.advance(29_999);
    expect(target.calls).toEqual([]);
    clock.advance(1);

    expect(target.calls).toEqual([true]);
    expect(controller.isSuspended()).toBe(true);
  });

  it("does not suspend when the app comes back within the grace", () => {
    const { clock, target, controller } = setup();

    controller.setVisible(false);
    clock.advance(20_000);
    controller.setVisible(true);
    clock.advance(60_000);

    expect(target.calls).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("restarts the grace on every departure", () => {
    const { clock, target, controller } = setup();

    controller.setVisible(false);
    clock.advance(20_000);
    controller.setVisible(true);
    controller.setVisible(false);
    clock.advance(20_000);
    expect(target.calls).toEqual([]);
    clock.advance(10_000);

    expect(target.calls).toEqual([true]);
  });

  it("resumes at once when the app is shown again", () => {
    const { clock, target, controller } = setup();

    controller.setVisible(false);
    clock.advance(30_000);
    controller.setVisible(true);

    expect(target.calls).toEqual([true, false]);
    expect(controller.isSuspended()).toBe(false);
  });

  it("starts the grace for an app launched out of view", () => {
    const { clock, target } = setup(false);

    clock.advance(30_000);

    expect(target.calls).toEqual([true]);
  });

  it("waits for a hold taken before the grace ends, then suspends on release", () => {
    const { clock, target, controller } = setup();
    const release = controller.hold();

    controller.setVisible(false);
    clock.advance(120_000);
    expect(target.calls).toEqual([]);

    release();
    expect(target.calls).toEqual([true]);
    release();
    expect(target.calls).toEqual([true]);
  });

  it("does not suspend on release while the app is in view or the grace is running", () => {
    const { clock, target, controller } = setup();
    const first = controller.hold();
    first();

    controller.setVisible(false);
    const second = controller.hold();
    clock.advance(10_000);
    second();

    expect(target.calls).toEqual([]);
    clock.advance(20_000);
    expect(target.calls).toEqual([true]);
  });

  it("stops timing after dispose", () => {
    const { clock, target, controller } = setup();

    controller.setVisible(false);
    controller.dispose();
    clock.advance(60_000);

    expect(target.calls).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
