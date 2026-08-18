import { describe, expect, test } from "vitest";
import {
  disableFocusOnNavigation,
  shouldRequestBrowserPopupActivation,
  shouldRestoreUnexpectedPopupFocus,
} from "./focus-policy";

describe("browser WebContents focus policy", () => {
  test("disables Chromium's navigation autofocus for embedded browser targets", () => {
    const preferences = disableFocusOnNavigation({
      sandbox: true,
      focusOnNavigation: true,
    });

    expect(preferences).toEqual({ sandbox: true, focusOnNavigation: false });
  });

  test("activates a popup only from the authoritative human target", () => {
    const base = {
      disposition: "new-window",
      hostWindowFocused: true,
      openerFocused: true,
      openerIsAuthoritativeTarget: true,
      recentlyAutomated: false,
    };
    expect(shouldRequestBrowserPopupActivation(base)).toBe(true);
    expect(
      shouldRequestBrowserPopupActivation({ ...base, openerIsAuthoritativeTarget: false }),
    ).toBe(false);
    expect(shouldRequestBrowserPopupActivation({ ...base, recentlyAutomated: true })).toBe(false);
    expect(shouldRequestBrowserPopupActivation({ ...base, disposition: "background-tab" })).toBe(
      false,
    );
  });

  test("restores focus only when a background popup itself unexpectedly took it", () => {
    const base = {
      currentFocusedContentsId: 30,
      hostWindowFocused: true,
      popupContentsId: 30,
      previousFocusedContentsId: 10,
      requestActivation: false,
    };
    expect(shouldRestoreUnexpectedPopupFocus(base)).toBe(true);
    expect(shouldRestoreUnexpectedPopupFocus({ ...base, currentFocusedContentsId: 20 })).toBe(
      false,
    );
    expect(shouldRestoreUnexpectedPopupFocus({ ...base, requestActivation: true })).toBe(false);
    expect(shouldRestoreUnexpectedPopupFocus({ ...base, hostWindowFocused: false })).toBe(false);
  });
});
