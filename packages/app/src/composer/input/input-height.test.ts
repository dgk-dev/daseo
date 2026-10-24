import { describe, expect, it } from "vitest";
import { resolveMaxInputHeight } from "./input-height";

describe("resolveMaxInputHeight", () => {
  it("falls back to the default without a window height", () => {
    expect(resolveMaxInputHeight(0)).toBe(160);
    expect(resolveMaxInputHeight(Number.NaN)).toBe(160);
  });

  it("uses the window height alone while the keyboard is hidden", () => {
    expect(resolveMaxInputHeight(916)).toBe(412);
    expect(resolveMaxInputHeight(916, 0)).toBe(412);
  });

  it("subtracts the keyboard so the composer stays below the header", () => {
    // Fold 7 cover screen with the Samsung keyboard up.
    expect(resolveMaxInputHeight(916, 320)).toBe(268);
    // Fold 7 inner screen.
    expect(resolveMaxInputHeight(712, 280)).toBe(194);
  });

  it("never goes below the default and ignores a bad keyboard height", () => {
    expect(resolveMaxInputHeight(300, 200)).toBe(160);
    expect(resolveMaxInputHeight(916, -10)).toBe(412);
    expect(resolveMaxInputHeight(916, Number.NaN)).toBe(412);
  });
});
