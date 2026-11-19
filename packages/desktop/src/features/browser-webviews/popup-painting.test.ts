import { describe, expect, it } from "vitest";
import { FocusEmulationHold, shouldHoldFocusEmulation } from "./popup-painting";

function recordingPort(options: { failFirst?: boolean } = {}) {
  const calls: boolean[] = [];
  let failNext = options.failFirst === true;
  return {
    calls,
    port: {
      setFocusEmulation: async (enabled: boolean) => {
        if (failNext) {
          failNext = false;
          throw new Error("debugger unavailable");
        }
        calls.push(enabled);
      },
    },
  };
}

describe("shouldHoldFocusEmulation", () => {
  it("holds only an awake target that is not on screen", () => {
    expect(shouldHoldFocusEmulation({ awake: true, presented: false })).toBe(true);
    expect(shouldHoldFocusEmulation({ awake: true, presented: true })).toBe(false);
    expect(shouldHoldFocusEmulation({ awake: false, presented: false })).toBe(false);
    expect(shouldHoldFocusEmulation({ awake: false, presented: true })).toBe(false);
  });
});

describe("FocusEmulationHold", () => {
  it("holds while awake and parked, releases when presented or idle", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.setAwake(true);
    hold.setPresented(true);
    hold.setPresented(false);
    hold.setAwake(false);
    await hold.whenSettled();
    expect(calls).toEqual([true, false, true, false]);
    expect(hold.isHeld()).toBe(false);
  });

  it("sends nothing when the decision does not change", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.setAwake(true);
    hold.setAwake(true);
    hold.setPresented(false);
    await hold.whenSettled();
    expect(calls).toEqual([true]);
  });

  it("does not hold, or even attach to, a popup that starts presented", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.setPresented(true);
    hold.setAwake(true);
    await hold.whenSettled();
    expect(calls).toEqual([]);
    expect(hold.isHeld()).toBe(false);
  });

  it("holds a tab only once main reports it off screen (delta 134)", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port, () => {}, { initiallyPresented: true });
    hold.setAwake(true);
    await hold.whenSettled();
    expect(calls).toEqual([]);
    hold.setPresented(false);
    await hold.whenSettled();
    expect(calls).toEqual([true]);
    expect(hold.isHeld()).toBe(true);
    hold.setPresented(true);
    hold.setAwake(false);
    hold.setPresented(false);
    await hold.whenSettled();
    expect(calls).toEqual([true, false]);
  });

  it("sends nothing after a lost session when the hold is not wanted", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.setAwake(true);
    hold.setAwake(false);
    hold.invalidate();
    await hold.whenSettled();
    expect(calls).toEqual([true, false]);
  });

  it("retries after a failed command instead of trusting it", async () => {
    const { calls, port } = recordingPort({ failFirst: true });
    const errors: unknown[] = [];
    const hold = new FocusEmulationHold(port, (error) => errors.push(error));
    hold.setAwake(true);
    await hold.whenSettled();
    expect(errors).toHaveLength(1);
    expect(hold.isHeld()).toBe(false);
    hold.setPresented(false);
    await hold.whenSettled();
    expect(calls).toEqual([true]);
    expect(hold.isHeld()).toBe(true);
  });

  it("applies the hold again after its debugger session is gone", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.setAwake(true);
    hold.invalidate();
    await hold.whenSettled();
    expect(calls).toEqual([true, true]);
  });

  it("stops sending once the popup is gone", async () => {
    const { calls, port } = recordingPort();
    const hold = new FocusEmulationHold(port);
    hold.dispose();
    hold.setAwake(true);
    await hold.whenSettled();
    expect(calls).toEqual([]);
  });
});
