import { describe, expect, it } from "vitest";
import {
  canDesktopAppSidebarShare,
  canDesktopTaskRailShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopExplorerWidth,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
  resolveTaskRailToggle,
} from "@/components/desktop-sidebar-layout";
import { DEFAULT_EXPLORER_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH } from "@/stores/panel-store/state";

describe("desktop sidebar layout", () => {
  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("keeps the sidebar toggle window-owned beside left window controls", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "top-left",
      contentCorners: "top-right",
      sidebarToggleOwner: "window",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: true,
        hasTopLeftWindowControls: false,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "content",
    });
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: true,
      }),
    ).toEqual({
      sidebarCorners: "none",
      contentCorners: "both",
      sidebarToggleOwner: "window",
    });
  });

  it("hides the window-owned sidebar toggle when app chrome is suppressed", () => {
    expect(
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: false,
        hasTopLeftWindowControls: true,
        sidebarControlsEnabled: false,
      }).sidebarToggleOwner,
    ).toBe("none");
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("keeps a temporarily narrow explorer render-only", () => {
    expect(resolveDesktopExplorerWidth({ requestedWidth: 400, viewportWidth: 751 })).toBe(351);
    expect(resolveDesktopExplorerWidth({ requestedWidth: 400, viewportWidth: 1440 })).toBe(400);
  });

  it("yields app navigation to settings, and to an open rail on the native wide layout", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({
      isSettingsRoute: true,
      isWorkspaceExplorerOpen: false,
      requestedExplorerWidth: 400,
      viewportWidth: 751,
    });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);

    const explorerMinimum = resolveDesktopAppContentMinimum({
      isSettingsRoute: false,
      isWorkspaceExplorerOpen: true,
      requestedExplorerWidth: 400,
      viewportWidth: 751,
    });
    expect(explorerMinimum).toBe(751);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: explorerMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({
          isSettingsRoute: false,
          isWorkspaceExplorerOpen: true,
          requestedExplorerWidth: 400,
          viewportWidth: 1120,
        }),
        requestedSidebarWidth: 320,
        viewportWidth: 1120,
      }),
    ).toBe(true);
  });

  it("leaves the chat column 880 at 1440 with both panels at their defaults", () => {
    const sidebar = resolveDesktopSidebarWidth({
      requestedWidth: DEFAULT_SIDEBAR_WIDTH,
      viewportWidth: 1440,
    });
    const rail = resolveDesktopExplorerWidth({
      requestedWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      viewportWidth: 1440,
    });
    expect(sidebar).toBe(320);
    expect(rail).toBe(240);
    expect(1440 - sidebar - rail).toBe(880);
  });

  it("holds the task rail between 200 and the width that leaves the centre 400", () => {
    expect(resolveDesktopExplorerWidth({ requestedWidth: 120, viewportWidth: 1440 })).toBe(200);
    expect(resolveDesktopExplorerWidth({ requestedWidth: 240, viewportWidth: 620 })).toBe(220);
    expect(resolveDesktopExplorerWidth({ requestedWidth: 240, viewportWidth: 500 })).toBe(200);
  });

  describe("docked task rail beside the left sidebar", () => {
    // What the wide web layout draws: the navigation whenever it is open, and the rail only
    // when the centre keeps 400 beside both.
    const draws = (viewportWidth: number, isSidebarOpen = true) => {
      const sidebar =
        isSidebarOpen &&
        canDesktopAppSidebarShare({
          contentMinimumWidth: resolveDesktopAppContentMinimum({
            isSettingsRoute: false,
            isWorkspaceExplorerOpen: false,
            requestedExplorerWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
            viewportWidth,
          }),
          requestedSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
          viewportWidth,
        });
      const rail = canDesktopTaskRailShare({
        viewportWidth,
        isSidebarShown: sidebar,
        requestedSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        requestedRailWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      });
      return { sidebar, rail };
    };

    it("drops the rail, not the navigation, at 800 and 959", () => {
      expect(draws(800)).toEqual({ sidebar: true, rail: false });
      expect(draws(959)).toEqual({ sidebar: true, rail: false });
    });

    it("draws both from 960, and at 1280", () => {
      expect(draws(960)).toEqual({ sidebar: true, rail: true });
      expect(draws(1280)).toEqual({ sidebar: true, rail: true });
    });

    it("draws the rail in a narrow window once the navigation is closed", () => {
      expect(draws(800, false)).toEqual({ sidebar: false, rail: true });
      expect(draws(751, false)).toEqual({ sidebar: false, rail: true });
    });

    it("counts a widened rail or sidebar", () => {
      const fits = (requestedRailWidth: number, requestedSidebarWidth: number) =>
        canDesktopTaskRailShare({
          viewportWidth: 1280,
          isSidebarShown: true,
          requestedSidebarWidth,
          requestedRailWidth,
        });
      expect(fits(560, 320)).toBe(true);
      expect(fits(561, 320)).toBe(false);
      expect(fits(280, 600)).toBe(true);
      expect(fits(281, 600)).toBe(false);
    });

    it("toggles: a drawn rail closes, a rail without room asks the navigation to close", () => {
      const toggle = (isOpen: boolean, hasRoom: boolean, hasRoomWithoutSidebar = true) =>
        resolveTaskRailToggle({ isOpen, hasRoom, hasRoomWithoutSidebar });
      expect(toggle(true, true)).toBe("close");
      expect(toggle(false, true)).toBe("open");
      expect(toggle(true, false)).toBe("open-and-close-sidebar");
      expect(toggle(false, false)).toBe("open-and-close-sidebar");
      // Closing the navigation would not help: only the stored state changes.
      expect(toggle(false, false, false)).toBe("open");
    });
  });
});
