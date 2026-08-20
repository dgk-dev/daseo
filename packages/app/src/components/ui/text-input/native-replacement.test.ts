import { describe, expect, it, vi } from "vitest";
import {
  createPendingNativeTextReplacement,
  replaceNativeInputText,
  resolveNativeTextChangeAfterReplacement,
  type NativeTextReplacementTarget,
} from "./native-replacement";

function createTarget() {
  const clear = vi.fn<() => void>();
  const replaceText = vi.fn<(text: string, start: number, end: number) => void>();
  const setNativeProps = vi.fn<NativeTextReplacementTarget["setNativeProps"]>();
  const setSelection = vi.fn<(start: number, end: number) => void>();
  const target: NativeTextReplacementTarget = {
    clear,
    replaceText,
    setNativeProps,
    setSelection,
  };
  return { target, clear, replaceText, setNativeProps, setSelection };
}

describe("replaceNativeInputText", () => {
  it("prefers the event-count-aware native replacement command", () => {
    const { target, replaceText, clear, setNativeProps } = createTarget();

    replaceNativeInputText(target, "next", { start: 1, end: 3 });

    expect(replaceText).toHaveBeenCalledWith("next", 1, 3);
    expect(clear).not.toHaveBeenCalled();
    expect(setNativeProps).not.toHaveBeenCalled();
  });

  it("uses the public clear command when an event-aware replacement is unavailable", () => {
    const { target, clear, setNativeProps, setSelection } = createTarget();
    target.replaceText = undefined;

    replaceNativeInputText(target, "");

    expect(clear).toHaveBeenCalledOnce();
    expect(setSelection).toHaveBeenCalledWith(0, 0);
    expect(setNativeProps).not.toHaveBeenCalled();
  });

  it("falls back to setNativeProps for standard non-empty inputs", () => {
    const { target, setNativeProps, setSelection } = createTarget();
    target.replaceText = undefined;
    target.clear = undefined;

    replaceNativeInputText(target, "next", { start: 2, end: 2 });

    expect(setNativeProps).toHaveBeenCalledWith({
      text: "next",
      selection: { start: 2, end: 2 },
    });
    expect(setSelection).toHaveBeenCalledWith(2, 2);
  });
});

describe("resolveNativeTextChangeAfterReplacement", () => {
  it("reasserts the replacement when the exact old native value arrives late", () => {
    const pending = createPendingNativeTextReplacement("보낸 문장", "");

    expect(resolveNativeTextChangeAfterReplacement(pending, "보낸 문장")).toEqual({
      action: "reassert",
      pending,
    });
  });

  it("ignores the command acknowledgement and then accepts new typing", () => {
    const pending = createPendingNativeTextReplacement("before", "after");

    expect(resolveNativeTextChangeAfterReplacement(pending, "after")).toEqual({
      action: "ignore",
      pending: null,
    });
    expect(resolveNativeTextChangeAfterReplacement(null, "after!")).toEqual({
      action: "accept",
      pending: null,
    });
  });

  it("accepts immediate new user input rather than treating every differing event as stale", () => {
    const pending = createPendingNativeTextReplacement("sent", "");

    expect(resolveNativeTextChangeAfterReplacement(pending, "새 입력")).toEqual({
      action: "accept",
      pending: null,
    });
  });
});
