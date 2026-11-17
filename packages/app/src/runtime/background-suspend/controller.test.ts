import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SUSPEND_GRACE_MS,
  createBackgroundSuspendController,
  type BackgroundSuspendScheduler,
} from "./controller";

// Stands in for the native Android timer: fires only when the test advances it. `now` is the
// wall clock; `sleep` moves it without firing timers, as device deep sleep or a frozen process
// does to Android's main-looper timer.
function createManualScheduler() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const cancelled: Array<() => void> = [];
  let nextId = 1;
  const scheduler: BackgroundSuspendScheduler = {
    schedule(delayMs, callback) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        const timer = timers.get(id);
        if (timer) {
          timers.delete(id);
          cancelled.push(timer.callback);
        }
      };
    },
  };
  return {
    scheduler,
    now: () => now,
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
    sleep(ms: number) {
      now += ms;
    },
    /** The native event of a cancelled timer that was already on its way to JS. */
    deliverCancelledEvents() {
      for (const callback of cancelled.splice(0)) callback();
    },
  };
}

function createTarget() {
  const calls: boolean[] = [];
  // Every connection-level effect in order: a suspend or resume, a cycle, a liveness check.
  const effects: string[] = [];
  return {
    calls,
    effects,
    setBackgroundSuspended: (suspended: boolean) => {
      calls.push(suspended);
      effects.push(suspended ? "suspend" : "resume");
    },
    cycleConnections: () => effects.push("cycle"),
    verifyConnections: () => effects.push("verify"),
  };
}

function setup(initiallyVisible = true) {
  const clock = createManualScheduler();
  const target = createTarget();
  const controller = createBackgroundSuspendController({
    target,
    scheduler: clock.scheduler,
    initiallyVisible,
    now: clock.now,
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

  describe("return after the grace timer starved (device sleep or a frozen process)", () => {
    it("cycles every connection once when the wall clock says the whole grace passed", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.advance(5_000);
      clock.sleep(10 * 60_000);
      controller.setVisible(true);

      expect(target.effects).toEqual(["cycle"]);
      expect(controller.isSuspended()).toBe(false);
      expect(clock.pending()).toBe(0);
    });

    it("cycles an app launched out of view whose timer never fired", () => {
      const { clock, target, controller } = setup(false);

      clock.sleep(30_000);
      controller.setVisible(true);

      expect(target.effects).toEqual(["cycle"]);
    });

    it("only resumes when the suspend did fire", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.advance(30_000);
      clock.sleep(10 * 60_000);
      controller.setVisible(true);

      expect(target.effects).toEqual(["suspend", "resume"]);
    });

    it("asks for a liveness check, not a cycle, after a shorter absence", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.advance(1_000);
      clock.sleep(28_999);
      controller.setVisible(true);

      expect(target.effects).toEqual(["verify"]);
    });

    it("never cuts a held connection: a liveness check instead of a cycle", () => {
      const { clock, target, controller } = setup();
      const release = controller.hold();

      controller.setVisible(false);
      clock.sleep(5 * 60_000);
      controller.setVisible(true);
      release();

      expect(target.effects).toEqual(["verify"]);
      expect(controller.isSuspended()).toBe(false);
    });

    it("timer event first, then the app shows: one disconnect, one reconnect", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.sleep(10 * 60_000);
      clock.advance(30_000); // the starved timer runs as the process thaws
      controller.setVisible(true);

      expect(target.effects).toEqual(["suspend", "resume"]);
      expect(controller.isSuspended()).toBe(false);
    });

    it("the app shows first, then the stale timer event lands: one cycle, nothing sticks", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.sleep(10 * 60_000);
      controller.setVisible(true);
      clock.deliverCancelledEvents();
      clock.advance(60_000);

      expect(target.effects).toEqual(["cycle"]);
      expect(controller.isSuspended()).toBe(false);
    });

    it("a stale timer event cannot shorten the next grace", () => {
      const { clock, target, controller } = setup();

      controller.setVisible(false);
      clock.advance(10_000);
      controller.setVisible(true);
      controller.setVisible(false);
      clock.deliverCancelledEvents();
      clock.advance(29_999);

      expect(target.calls).toEqual([]);
      clock.advance(1);
      expect(target.calls).toEqual([true]);
    });
  });
});
