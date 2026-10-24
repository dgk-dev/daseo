import { describe, expect, it } from "vitest";
import { diffTypedText, shouldResetTypedText } from "./remote-keyboard";

describe("diffTypedText", () => {
  it("inserts appended text", () => {
    expect(diffTypedText("", "a")).toEqual({ deleteCount: 0, insert: "a" });
    expect(diffTypedText("hel", "hello")).toEqual({ deleteCount: 0, insert: "lo" });
  });

  it("replays a Hangul composition as one delete and one insert per step", () => {
    expect(diffTypedText("", "ㅎ")).toEqual({ deleteCount: 0, insert: "ㅎ" });
    expect(diffTypedText("ㅎ", "하")).toEqual({ deleteCount: 1, insert: "하" });
    expect(diffTypedText("하", "한")).toEqual({ deleteCount: 1, insert: "한" });
    expect(diffTypedText("한", "한ㄱ")).toEqual({ deleteCount: 0, insert: "ㄱ" });
    expect(diffTypedText("한ㄱ", "한글")).toEqual({ deleteCount: 1, insert: "글" });
  });

  it("deletes when the field shrinks and counts code points, not UTF-16 units", () => {
    expect(diffTypedText("한글", "한")).toEqual({ deleteCount: 1, insert: "" });
    expect(diffTypedText("a😀", "a")).toEqual({ deleteCount: 1, insert: "" });
    expect(diffTypedText("abc", "abc")).toEqual({ deleteCount: 0, insert: "" });
  });
});

describe("shouldResetTypedText", () => {
  it("keeps short text and anything that may still be composing", () => {
    expect(shouldResetTypedText("")).toBe(false);
    expect(shouldResetTypedText("short text ")).toBe(false);
    expect(shouldResetTypedText(`${"a".repeat(130)}한`)).toBe(false);
    expect(shouldResetTypedText(`${"a".repeat(130)}ㅎ`)).toBe(false);
    expect(shouldResetTypedText("a".repeat(130))).toBe(false);
  });

  it("resets long text at a word boundary", () => {
    expect(shouldResetTypedText(`${"a".repeat(130)} `)).toBe(true);
    expect(shouldResetTypedText(`${"가".repeat(130)}. `)).toBe(true);
  });
});
