import { describe, expect, it } from "vitest";
import { estimateWidestBubbleLines, shouldFoldUserMessage } from "./user-message-fold";

describe("shouldFoldUserMessage", () => {
  it("leaves a message that fits twelve lines of the widest bubble alone", () => {
    expect(shouldFoldUserMessage("Fix the login bug")).toBe(false);
    expect(shouldFoldUserMessage(Array.from({ length: 12 }, () => "line").join("\n"))).toBe(false);
    expect(shouldFoldUserMessage("a".repeat(110 * 12))).toBe(false);
  });

  it("folds a message longer than twelve lines however it gets there", () => {
    expect(shouldFoldUserMessage(Array.from({ length: 13 }, () => "line").join("\n"))).toBe(true);
    expect(shouldFoldUserMessage("a".repeat(110 * 12 + 1))).toBe(true);
  });

  it("counts a Korean syllable as two columns", () => {
    expect(estimateWidestBubbleLines("가".repeat(55))).toBe(1);
    expect(estimateWidestBubbleLines("가".repeat(56))).toBe(2);
    expect(shouldFoldUserMessage("가".repeat(55 * 12 + 1))).toBe(true);
  });

  it("ignores trailing blank lines", () => {
    expect(shouldFoldUserMessage(`short${"\n".repeat(20)}`)).toBe(false);
  });
});
