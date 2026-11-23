import { describe, expect, it } from "vitest";
import { resolveKeyboardShift, shouldResetKeyboardOffsetOnResume } from "./keyboard-shift-policy";

describe("resolveKeyboardShift", () => {
  it("keeps the existing open-keyboard offset behavior", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 1,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(296);
  });

  it("treats progress zero as closed even when Android reports a stale height", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 0,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });

  it("still ignores small iOS accessory bar reports", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 80,
        keyboardProgress: 1,
        bottomInset: 0,
        isIos: true,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });
});

describe("shouldResetKeyboardOffsetOnResume", () => {
  it("zeroes an offset the system no longer backs with a keyboard", () => {
    expect(
      shouldResetKeyboardOffsetOnResume({
        systemKeyboardVisible: false,
        rawKeyboardHeight: 357,
        keyboardProgress: 1,
      }),
    ).toBe(true);
  });

  it("leaves an open keyboard alone", () => {
    expect(
      shouldResetKeyboardOffsetOnResume({
        systemKeyboardVisible: true,
        rawKeyboardHeight: 357,
        keyboardProgress: 1,
      }),
    ).toBe(false);
  });

  it("does nothing when the offset is already closed", () => {
    expect(
      shouldResetKeyboardOffsetOnResume({
        systemKeyboardVisible: false,
        rawKeyboardHeight: 0,
        keyboardProgress: 0,
      }),
    ).toBe(false);
  });
});
