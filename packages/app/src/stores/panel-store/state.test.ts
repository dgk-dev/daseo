import { describe, expect, it } from "vitest";
import {
  buildExplorerCheckoutKey,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "@/stores/explorer-tab-memory";
import {
  buildExplorerTabForCheckoutPatch,
  buildOpenFileExplorerPatch,
  buildToggleFileExplorerPatch,
  clampExplorerWidth,
  DEFAULT_EXPLORER_SIDEBAR_WIDTH,
  DEFAULT_NATIVE_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  isTaskRailDockedByDefault,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  migratePanelState,
  selectIsAgentListOpen,
  selectIsFileExplorerOpen,
  setMobilePanelTarget,
  selectPanelVisibility,
  type PanelCoreState,
} from "./state";

function makePanelState(overrides: Partial<PanelCoreState> = {}): PanelCoreState {
  return {
    mobilePanel: { target: "agent", revision: 0 },
    desktop: {
      agentListOpen: false,
      fileExplorerOpen: false,
      focusModeEnabled: false,
    },
    explorerTab: "changes",
    explorerTabByCheckout: {},
    ...overrides,
  };
}

describe("panel-store explorer tab resolution", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo";

  it("defaults to changes for git checkouts", () => {
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {},
      }),
    ).toBe("changes");
  });

  it("defaults to files for non-git checkouts", () => {
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: false,
        explorerTabByCheckout: {},
      }),
    ).toBe("files");
  });

  it("restores a stored files tab for git checkouts", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {
          [key]: "files",
        },
      }),
    ).toBe("files");
  });

  it("falls back to default when stored tab is invalid", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {
          [key]: "terminals" as unknown as ExplorerTab,
        },
      }),
    ).toBe("changes");
  });

  it("coerces stored changes to files for non-git checkouts", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: false,
        explorerTabByCheckout: {
          [key]: "changes",
        },
      }),
    ).toBe("files");
  });
});

describe("panel-store migration", () => {
  it("defaults hidden-file visibility to showing hidden files", () => {
    const state = migratePanelState({}, 10, { isWeb: false });

    expect(state.explorerShowHiddenFiles).toBe(true);
  });

  it("initializes diffCollapsedFoldersByWorkspace for pre-v12 state", () => {
    const state = migratePanelState({}, 11, { isWeb: false });

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({});
  });

  it("preserves an existing diffCollapsedFoldersByWorkspace map", () => {
    const state = migratePanelState({ diffCollapsedFoldersByWorkspace: { ws: ["src/app"] } }, 12, {
      isWeb: false,
    });

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({ ws: ["src/app"] });
  });

  it("drops persisted compact panel state so cold starts return to content", () => {
    const state = migratePanelState(
      { mobileView: "agent-list", mobilePanel: { target: "file-explorer", revision: 42 } },
      11,
      { isWeb: false },
    );

    expect(state.mobileView).toBeUndefined();
    expect(state.mobilePanel).toBeUndefined();
  });

  // Daseo delta 105: the native app's left sidebar defaults to 260.
  it("moves a native width still at the old 320 default to 260", () => {
    const state = migratePanelState({ sidebarWidth: 320 }, 12, { isWeb: false });

    expect(state.sidebarWidth).toBe(DEFAULT_NATIVE_SIDEBAR_WIDTH);
    expect(DEFAULT_NATIVE_SIDEBAR_WIDTH).toBe(260);
  });

  it("keeps a native width chosen by hand", () => {
    const state = migratePanelState({ sidebarWidth: 410 }, 12, { isWeb: false });

    expect(state.sidebarWidth).toBe(410);
  });

  it("keeps 320 on web and the desktop app", () => {
    const state = migratePanelState({ sidebarWidth: 320 }, 12, { isWeb: true });

    expect(state.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(320);
  });

  it("gives a native state without a width the 260 default", () => {
    expect(migratePanelState({}, 12, { isWeb: false }).sidebarWidth).toBe(260);
    expect(migratePanelState({}, 13, { isWeb: false }).sidebarWidth).toBe(260);
    expect(migratePanelState({}, 12, { isWeb: true }).sidebarWidth).toBe(320);
  });

  it("leaves a native 320 alone once it is at the current version", () => {
    const state = migratePanelState({ sidebarWidth: 320 }, 13, { isWeb: false });

    expect(state.sidebarWidth).toBe(320);
  });
});

describe("panel-store visibility selectors", () => {
  it("increments the mobile panel revision only when the target changes", () => {
    const initial = { target: "agent" as const, revision: 4 };

    expect(setMobilePanelTarget(initial, "agent")).toBe(initial);
    expect(setMobilePanelTarget(initial, "agent-list")).toEqual({
      target: "agent-list",
      revision: 5,
    });
  });

  it("uses the mobile panel target for compact layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, fileExplorerOpen: false, focusModeEnabled: false },
    });

    expect(selectPanelVisibility(state, { isCompact: true })).toEqual({
      isAgentListOpen: false,
      isFileExplorerOpen: true,
    });
    expect(selectIsAgentListOpen(state, { isCompact: true })).toBe(false);
    expect(selectIsFileExplorerOpen(state, { isCompact: true })).toBe(true);
  });

  it("uses desktop flags for expanded layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, fileExplorerOpen: false, focusModeEnabled: false },
    });

    expect(selectPanelVisibility(state, { isCompact: false })).toEqual({
      isAgentListOpen: true,
      isFileExplorerOpen: false,
    });
    expect(selectIsAgentListOpen(state, { isCompact: false })).toBe(true);
    expect(selectIsFileExplorerOpen(state, { isCompact: false })).toBe(false);
  });
});

// Daseo delta 101: the right panel holds the task list on every layout; opening it needs no
// checkout, and an explorer request only remembers the explorer tab.
describe("panel-store right panel actions", () => {
  it("opens the compact overlay without a checkout", () => {
    const state = makePanelState({ mobilePanel: { target: "agent", revision: 3 } });

    expect(buildOpenFileExplorerPatch(state, { isCompact: true })).toEqual({
      mobilePanel: { target: "file-explorer", revision: 4 },
    });
  });

  it("opens the wide sidebar without a checkout", () => {
    const state = makePanelState();

    expect(buildOpenFileExplorerPatch(state, { isCompact: false })).toEqual({
      desktop: { agentListOpen: false, fileExplorerOpen: true, focusModeEnabled: false },
    });
  });

  it("does nothing when the panel is already open", () => {
    const compactOpen = makePanelState({ mobilePanel: { target: "file-explorer", revision: 1 } });
    const wideOpen = makePanelState({
      desktop: { agentListOpen: false, fileExplorerOpen: true, focusModeEnabled: false },
    });

    expect(buildOpenFileExplorerPatch(compactOpen, { isCompact: true })).toBeNull();
    expect(buildOpenFileExplorerPatch(wideOpen, { isCompact: false })).toBeNull();
  });

  it("opens the compact overlay from the agent list too", () => {
    const state = makePanelState({ mobilePanel: { target: "agent-list", revision: 2 } });

    expect(buildToggleFileExplorerPatch(state, { isCompact: true })).toEqual({
      mobilePanel: { target: "file-explorer", revision: 3 },
    });
  });

  it("toggles the compact overlay back to the chat", () => {
    const state = makePanelState({ mobilePanel: { target: "file-explorer", revision: 5 } });

    expect(buildToggleFileExplorerPatch(state, { isCompact: true })).toEqual({
      mobilePanel: { target: "agent", revision: 6 },
    });
  });

  it("toggles each layout without touching the other one", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, fileExplorerOpen: false, focusModeEnabled: false },
    });

    expect(buildToggleFileExplorerPatch(state, { isCompact: false })).toEqual({
      desktop: { agentListOpen: true, fileExplorerOpen: true, focusModeEnabled: false },
    });
  });

  it("toggles the wide sidebar closed without changing the explorer tab", () => {
    const state = makePanelState({
      desktop: { agentListOpen: false, fileExplorerOpen: true, focusModeEnabled: false },
      explorerTab: "files",
    });

    expect(buildToggleFileExplorerPatch(state, { isCompact: false })).toEqual({
      desktop: { agentListOpen: false, fileExplorerOpen: false, focusModeEnabled: false },
    });
  });
});

describe("panel-store explorer requests", () => {
  it("resolves the remembered tab of the checkout and changes no panel", () => {
    const checkout = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };
    const key = buildExplorerCheckoutKey(checkout.serverId, checkout.cwd)!;
    const state = makePanelState({
      explorerTab: "changes",
      explorerTabByCheckout: { [key]: "files" },
    });

    expect(buildExplorerTabForCheckoutPatch(state, checkout)).toEqual({ explorerTab: "files" });
  });

  it("coerces changes to files for a non-git checkout", () => {
    const checkout = { serverId: "server-1", cwd: "/tmp/repo", isGit: false };
    const key = buildExplorerCheckoutKey(checkout.serverId, checkout.cwd)!;
    const state = makePanelState({
      explorerTab: "changes",
      explorerTabByCheckout: { [key]: "changes" },
    });

    expect(buildExplorerTabForCheckoutPatch(state, checkout)).toEqual({ explorerTab: "files" });
  });
});

describe("panel-store task rail", () => {
  it("is 240 wide by default and no narrower than 200", () => {
    expect(DEFAULT_EXPLORER_SIDEBAR_WIDTH).toBe(240);
    expect(MIN_EXPLORER_SIDEBAR_WIDTH).toBe(200);
    expect(clampExplorerWidth(120)).toBe(200);
    expect(clampExplorerWidth(200)).toBe(200);
    expect(clampExplorerWidth(640)).toBe(640);
    expect(clampExplorerWidth(Number.NaN)).toBe(200);
  });

  it("brings a stored width above the old minimum back to the default once", () => {
    for (const isWeb of [true, false]) {
      expect(migratePanelState({ explorerWidth: 400 }, 13, { isWeb }).explorerWidth).toBe(240);
      expect(migratePanelState({ explorerWidth: 281 }, 13, { isWeb }).explorerWidth).toBe(240);
      expect(migratePanelState({ explorerWidth: 1200 }, 13, { isWeb }).explorerWidth).toBe(240);
      expect(migratePanelState({ explorerWidth: 280 }, 13, { isWeb }).explorerWidth).toBe(280);
      expect(migratePanelState({ explorerWidth: 120 }, 13, { isWeb }).explorerWidth).toBe(200);
    }
  });

  it("keeps a width chosen after the migration", () => {
    expect(migratePanelState({ explorerWidth: 520 }, 14, { isWeb: true }).explorerWidth).toBe(520);
    expect(migratePanelState({ explorerWidth: 210 }, 14, { isWeb: true }).explorerWidth).toBe(210);
  });

  it("leaves a state without a stored width to the store default", () => {
    expect(migratePanelState({}, 13, { isWeb: true }).explorerWidth).toBeUndefined();
  });

  it("is docked by default on the desktop app and the web, not on the native wide layout", () => {
    expect(isTaskRailDockedByDefault(true)).toBe(true);
    expect(isTaskRailDockedByDefault(false)).toBe(false);
  });

  it("opens the rail once on the web and keeps the other sidebar choices", () => {
    const closed = { agentListOpen: false, fileExplorerOpen: false, focusModeEnabled: true };
    expect(migratePanelState({ desktop: closed }, 13, { isWeb: true }).desktop).toEqual({
      agentListOpen: false,
      fileExplorerOpen: true,
      focusModeEnabled: true,
    });
    expect(migratePanelState({}, 13, { isWeb: true }).desktop?.fileExplorerOpen).toBe(true);
  });

  it("does not open it on native, and not again after the owner closed it", () => {
    const closed = { agentListOpen: true, fileExplorerOpen: false, focusModeEnabled: false };
    expect(migratePanelState({ desktop: closed }, 13, { isWeb: false }).desktop).toEqual(closed);
    expect(migratePanelState({ desktop: closed }, 14, { isWeb: true }).desktop).toEqual(closed);
  });
});
