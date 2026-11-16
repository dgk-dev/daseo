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

describe("a sent prompt stays sent (Daseo delta 96)", () => {
  // The composer clears itself on send, the draft echoes that clear back through
  // textReplacementKey, and the input re-applies the same empty text. Android can drop the first
  // clear as stale while an IME commit is in flight; that commit then arrives with the whole
  // prompt and must be pushed back out, not taken as new typing.
  it("keeps the guard when the same replacement is applied again", () => {
    const prompt = "엄청 긴 프롬프트 ".repeat(400);
    const sent = createPendingNativeTextReplacement(prompt, "");
    const echoed = createPendingNativeTextReplacement("", "", sent);

    expect(echoed).toBe(sent);
    expect(resolveNativeTextChangeAfterReplacement(echoed, prompt)).toEqual({
      action: "reassert",
      pending: { previousText: prompt, expectedText: "" },
    });
  });

  // 2026-11-16: a dictated prompt came back after sending on 0.5.125. Voice typing finalises
  // its last phrase on send, so the late event is the prompt with a changed tail, not a copy.
  it("pushes the replacement out again when the late commit changed the prompt's tail", () => {
    const prompt = "사이드바도 다 디자인 통일되고, 본문 시작 높이도 통일되";
    const sent = createPendingNativeTextReplacement(prompt, "");

    for (const late of [`${prompt}고.`, `${prompt} `, `${prompt.slice(0, -3)}통일되고.`]) {
      expect(resolveNativeTextChangeAfterReplacement(sent, late)).toEqual({
        action: "reassert",
        pending: sent,
      });
    }
  });

  it("accepts typing that continues the replacement, and short prompts typed again", () => {
    const longPrompt = "긴 프롬프트의 앞부분이 그대로 이어지는 문장 @fi";
    const completed = createPendingNativeTextReplacement(longPrompt, `${longPrompt}le.ts `);
    expect(resolveNativeTextChangeAfterReplacement(completed, `${longPrompt}le.ts a`)).toEqual({
      action: "accept",
      pending: null,
    });

    const short = createPendingNativeTextReplacement("네 알겠습니다", "");
    expect(resolveNativeTextChangeAfterReplacement(short, "네 알겠습니다 그리고")).toEqual({
      action: "accept",
      pending: null,
    });

    const sent = createPendingNativeTextReplacement("처음 보낸 긴 프롬프트의 전체 내용입니다", "");
    expect(resolveNativeTextChangeAfterReplacement(sent, "처음 보낸 것과 다른 새 글")).toEqual({
      action: "accept",
      pending: null,
    });
  });

  it("drops the guard once the native input reports the replaced text", () => {
    const sent = createPendingNativeTextReplacement("prompt", "");
    const settled = resolveNativeTextChangeAfterReplacement(sent, "");

    expect(settled).toEqual({ action: "ignore", pending: null });
    expect(createPendingNativeTextReplacement("", "", settled.pending)).toBeNull();
  });

  it("starts a new guard for a different replacement", () => {
    const sent = createPendingNativeTextReplacement("prompt", "");

    expect(createPendingNativeTextReplacement("", "restored", sent)).toEqual({
      previousText: "",
      expectedText: "restored",
    });
  });
});
