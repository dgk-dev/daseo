import { describe, expect, it } from "vitest";
import { resolveModelSheetLayout } from "./model-sheet-layout";

describe("model sheet layout", () => {
  it("uses the sheet-aware scroller inside a bottom sheet", () => {
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: true,
        isKeyboardVisible: false,
        hasControls: true,
      }).scrolling,
    ).toBe("bottom-sheet");
  });

  it("keeps the independent viewport off the bottom sheet", () => {
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: false,
        isKeyboardVisible: false,
        hasControls: true,
      }).scrolling,
    ).toBe("independent");
  });

  it("hides the controls footer while the keyboard covers the sheet", () => {
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: true,
        isKeyboardVisible: true,
        hasControls: true,
      }).showControlsFooter,
    ).toBe(false);
  });

  it("restores the controls footer once the keyboard closes", () => {
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: true,
        isKeyboardVisible: false,
        hasControls: true,
      }).showControlsFooter,
    ).toBe(true);
  });

  it("never renders a controls footer off the bottom sheet or without controls", () => {
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: false,
        isKeyboardVisible: false,
        hasControls: true,
      }).showControlsFooter,
    ).toBe(false);
    expect(
      resolveModelSheetLayout({
        usesBottomSheet: true,
        isKeyboardVisible: false,
        hasControls: false,
      }).showControlsFooter,
    ).toBe(false);
  });
});
