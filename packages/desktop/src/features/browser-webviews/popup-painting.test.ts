import { describe, expect, it } from "vitest";
import { PopupPaintHold, shouldHoldPopupPainting } from "./popup-painting";

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

describe("shouldHoldPopupPainting", () => {
  it("holds only an awake popup that is parked", () => {
    expect(shouldHoldPopupPainting({ awake: true, presented: false })).toBe(true);
    expect(shouldHoldPopupPainting({ awake: true, presented: true })).toBe(false);
    expect(shouldHoldPopupPainting({ awake: false, presented: false })).toBe(false);
    expect(shouldHoldPopupPainting({ awake: false, presented: true })).toBe(false);
  });
});

describe("PopupPaintHold", () => {
  it("holds while awake and parked, releases when presented or idle", async () => {
    const { calls, port } = recordingPort();
    const hold = new PopupPaintHold(port);
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
    const hold = new PopupPaintHold(port);
    hold.setAwake(true);
    hold.setAwake(true);
    hold.setPresented(false);
    await hold.whenSettled();
    expect(calls).toEqual([true]);
  });

  it("does not hold a popup that starts presented", async () => {
    const { calls, port } = recordingPort();
    const hold = new PopupPaintHold(port);
    hold.setPresented(true);
    hold.setAwake(true);
    await hold.whenSettled();
    expect(calls).toEqual([false]);
    expect(hold.isHeld()).toBe(false);
  });

  it("retries after a failed command instead of trusting it", async () => {
    const { calls, port } = recordingPort({ failFirst: true });
    const errors: unknown[] = [];
    const hold = new PopupPaintHold(port, (error) => errors.push(error));
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
    const hold = new PopupPaintHold(port);
    hold.setAwake(true);
    hold.invalidate();
    await hold.whenSettled();
    expect(calls).toEqual([true, true]);
  });

  it("stops sending once the popup is gone", async () => {
    const { calls, port } = recordingPort();
    const hold = new PopupPaintHold(port);
    hold.dispose();
    hold.setAwake(true);
    await hold.whenSettled();
    expect(calls).toEqual([]);
  });
});
