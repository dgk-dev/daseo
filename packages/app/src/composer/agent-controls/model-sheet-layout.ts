import type { ModelBrowserScrolling } from "@/components/model-browser";

export interface ModelSheetLayoutInput {
  /** The sheet is presented as a @gorhom bottom sheet (compact form factor). */
  usesBottomSheet: boolean;
  /** The software keyboard is on screen, so the sheet body is much shorter. */
  isKeyboardVisible: boolean;
  /** There are agent controls to show below the model list. */
  hasControls: boolean;
}

export interface ModelSheetLayout {
  scrolling: ModelBrowserScrolling;
  /**
   * The controls footer stands down while the keyboard is up. The sheet extends
   * over the keyboard rather than scrolling behind it, so keeping both would
   * leave the model list — the thing being searched — a few pixels tall.
   */
  showControlsFooter: boolean;
}

export function resolveModelSheetLayout(input: ModelSheetLayoutInput): ModelSheetLayout {
  return {
    // Inside a bottom sheet the list must use the sheet-aware scroller, or the
    // sheet's content pan gesture eats the drag and the last rows are
    // unreachable. Everywhere else the browser owns a plain viewport.
    scrolling: input.usesBottomSheet ? "bottom-sheet" : "independent",
    showControlsFooter: input.usesBottomSheet && input.hasControls && !input.isKeyboardVisible,
  };
}
