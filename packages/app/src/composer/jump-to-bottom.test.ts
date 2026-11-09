import { describe, expect, it, vi } from "vitest";
import { createJumpToBottomBridge } from "./jump-to-bottom";

describe("jump-to-bottom bridge", () => {
  it("starts hidden and hands the stream's state to subscribers", () => {
    const bridge = createJumpToBottomBridge();
    expect(bridge.get()).toEqual({ visible: false, jump: null });

    const listener = vi.fn();
    bridge.subscribe(listener);
    const jump = vi.fn();
    bridge.set({ visible: true, jump });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.get().visible).toBe(true);
    bridge.get().jump?.();
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it("does not notify when nothing changed, and stops after unsubscribe", () => {
    const bridge = createJumpToBottomBridge();
    const jump = vi.fn();
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);

    bridge.set({ visible: true, jump });
    bridge.set({ visible: true, jump });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    bridge.set({ visible: false, jump });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.get().visible).toBe(false);
  });
});
