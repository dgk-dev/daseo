import { describe, expect, test } from "vitest";
import {
  resolveWorkspaceActiveBrowserId,
  shouldClaimBrowserSurfaceFocus,
  shouldRepelBrowserSurfaceFocus,
} from "./focus-policy";

describe("desktop browser focus policy", () => {
  test("only advertises a browser from the foreground workspace", () => {
    expect(
      resolveWorkspaceActiveBrowserId({ focusedBrowserId: "browser-1", isRouteFocused: true }),
    ).toBe("browser-1");
    expect(
      resolveWorkspaceActiveBrowserId({ focusedBrowserId: "browser-1", isRouteFocused: false }),
    ).toBeNull();
  });

  test("repels surface focus whenever the pane is hidden or non-interactive", () => {
    expect(shouldRepelBrowserSurfaceFocus({ isInteractive: true, isPresented: true })).toBe(false);
    expect(shouldRepelBrowserSurfaceFocus({ isInteractive: false, isPresented: true })).toBe(true);
    expect(shouldRepelBrowserSurfaceFocus({ isInteractive: true, isPresented: false })).toBe(true);
    expect(shouldRepelBrowserSurfaceFocus({ isInteractive: false, isPresented: false })).toBe(true);
  });

  test("claims physical focus only for a trusted pointer in the visible interactive pane", () => {
    expect(
      shouldClaimBrowserSurfaceFocus({
        isInteractive: true,
        isPresented: true,
        isTrustedPointerEvent: true,
      }),
    ).toBe(true);
    expect(
      shouldClaimBrowserSurfaceFocus({
        isInteractive: false,
        isPresented: true,
        isTrustedPointerEvent: true,
      }),
    ).toBe(false);
    expect(
      shouldClaimBrowserSurfaceFocus({
        isInteractive: true,
        isPresented: false,
        isTrustedPointerEvent: true,
      }),
    ).toBe(false);
    expect(
      shouldClaimBrowserSurfaceFocus({
        isInteractive: true,
        isPresented: true,
        isTrustedPointerEvent: false,
      }),
    ).toBe(false);
  });
});
