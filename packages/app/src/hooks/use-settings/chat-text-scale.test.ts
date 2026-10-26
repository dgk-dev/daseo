import { describe, expect, it } from "vitest";
import { normalizeChatTextScale } from "./storage";

describe("normalizeChatTextScale", () => {
  it("keeps 1–2 on 10% steps and rejects non-numbers", () => {
    expect(normalizeChatTextScale(1.1 + 0.1)).toBe(1.2);
    expect(normalizeChatTextScale(0.8)).toBe(1);
    expect(normalizeChatTextScale(2.7)).toBe(2);
    expect(normalizeChatTextScale(1.04)).toBe(1);
    expect(normalizeChatTextScale("1.5")).toBeNull();
    expect(normalizeChatTextScale(Number.NaN)).toBeNull();
  });
});
