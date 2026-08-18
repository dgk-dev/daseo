import { describe, expect, test } from "vitest";
import { resolveWebOverlayRegistrationActive, shouldRestoreWebOverlayFocus } from "./overlay-root";

describe("web overlay focus ownership", () => {
  test("does not register a portal overlay owned by a hidden retained panel", () => {
    expect(resolveWebOverlayRegistrationActive(true, true)).toBe(true);
    expect(resolveWebOverlayRegistrationActive(true, false)).toBe(false);
    expect(resolveWebOverlayRegistrationActive(false, true)).toBe(false);
  });

  test("does not restore a stale opener over a newer user focus", () => {
    expect(
      shouldRestoreWebOverlayFocus({
        activeElementIsDocumentBody: false,
        activeElementWithinClosingScope: false,
        restoreTargetConnected: true,
      }),
    ).toBe(false);
    expect(
      shouldRestoreWebOverlayFocus({
        activeElementIsDocumentBody: false,
        activeElementWithinClosingScope: true,
        restoreTargetConnected: true,
      }),
    ).toBe(true);
    expect(
      shouldRestoreWebOverlayFocus({
        activeElementIsDocumentBody: true,
        activeElementWithinClosingScope: false,
        restoreTargetConnected: true,
      }),
    ).toBe(true);
    expect(
      shouldRestoreWebOverlayFocus({
        activeElementIsDocumentBody: true,
        activeElementWithinClosingScope: false,
        restoreTargetConnected: false,
      }),
    ).toBe(false);
  });
});
