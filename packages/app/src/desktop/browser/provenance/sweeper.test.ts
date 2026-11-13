import { beforeEach, describe, expect, test } from "vitest";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import type {
  DesktopBrowserAutoCloseCheck,
  DesktopBrowserAutoCloseLogEntry,
  DesktopHostBridge,
} from "@/desktop/host";
import { getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useBrowserProvenanceStore } from "./index";
import { reopenRecentlyClosedBrowser } from "./reopen";
import { BrowserAutoCloseSweeper, type BrowserAutoCloseCreatorSnapshot } from "./sweeper";

class MemoryStorage implements StateStorage {
  private readonly values = new Map<string, string>();
  public getItem = (key: string): string | null => this.values.get(key) ?? null;
  public setItem = (key: string, value: string): void => {
    this.values.set(key, value);
  };
  public removeItem = (key: string): void => {
    this.values.delete(key);
  };
  public clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
for (const store of [useBrowserStore, useWorkspaceLayoutStore, useBrowserProvenanceStore]) {
  store.persist.setOptions({ storage: createJSONStorage(() => storage) } as never);
}

const SERVER = "server-1";
const WORKSPACE = "wks_a";
const KEY = buildWorkspaceTabPersistenceKey({ serverId: SERVER, workspaceId: WORKSPACE }) as string;
const HOUR = 3_600_000;

class FakeMain {
  public mode: DesktopBrowserAutoCloseCheck["mode"] = "rehearse";
  public blockers: Record<string, string | null> = {};
  public readonly logs: DesktopBrowserAutoCloseLogEntry[] = [];
  public readonly unregistered: string[] = [];

  public readonly bridge = {
    autoCloseCheck: async (browserIds: string[]) => ({
      mode: this.mode,
      afterHours: 24,
      blockers: Object.fromEntries(browserIds.map((id) => [id, this.blockers[id] ?? null])),
    }),
    recordAutoClose: async (entries: DesktopBrowserAutoCloseLogEntry[]) => {
      this.logs.push(...entries);
    },
    unregisterWorkspaceBrowser: async (browserId: string) => {
      this.unregistered.push(browserId);
    },
  } as unknown as NonNullable<DesktopHostBridge["browser"]>;
}

function agentOpensTab(agentId: string, url: string): { browserId: string; tabId: string } {
  const browserId = useBrowserStore.getState().createBrowser({ initialUrl: url });
  const tabId = useWorkspaceLayoutStore
    .getState()
    .openTabInBackground(KEY, { kind: "browser", browserId }) as string;
  useBrowserProvenanceStore.getState().agentOpened({ browserId, agentId });
  return { browserId, tabId };
}

function sweeperFor(
  main: FakeMain,
  agents: Record<string, BrowserAutoCloseCreatorSnapshot | null | "throws">,
  now = () => Date.now(),
) {
  return new BrowserAutoCloseSweeper({
    serverId: SERVER,
    fetchAgent: async (agentId) => {
      const agent = agents[agentId];
      if (agent === "throws") throw new Error("daemon unreachable");
      return agent ?? null;
    },
    getBrowserHost: () => main.bridge,
    closeTab: async ({ workspaceKey, tabId, browserId }) => {
      useWorkspaceLayoutStore.getState().closeTab(workspaceKey, tabId);
      useBrowserStore.getState().removeBrowser(browserId);
      useBrowserProvenanceStore.getState().forget(browserId);
      await main.bridge.unregisterWorkspaceBrowser?.(browserId);
    },
    now,
  });
}

function layoutBrowserIds(): string[] {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[KEY];
  return layout
    ? collectAllTabs(layout.root).flatMap((tab) =>
        tab.target.kind === "browser" ? [tab.target.browserId] : [],
      )
    : [];
}

const ARCHIVED: BrowserAutoCloseCreatorSnapshot = {
  status: "closed",
  archivedAt: "2026-11-13T00:00:00.000Z",
};

describe("BrowserAutoCloseSweeper (delta 98)", () => {
  beforeEach(async () => {
    storage.clear();
    await Promise.all([
      useBrowserStore.persist.rehydrate(),
      useWorkspaceLayoutStore.persist.rehydrate(),
      useBrowserProvenanceStore.persist.rehydrate(),
    ]);
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
    useBrowserProvenanceStore.setState({
      provenanceByBrowserId: {},
      agentLastCommandAt: {},
      recentlyClosedByWorkspace: {},
    });
    // A person's own tab holds the pane's selection, as in a real workspace.
    useWorkspaceLayoutStore.getState().openTabFocused(KEY, { kind: "draft", draftId: "person" });
  });

  test("in rehearsal an archived agent's unseen tab is logged as would close and stays open", async () => {
    const main = new FakeMain();
    const unseen = agentOpensTab("agent-a", "https://unseen.test/page");
    const seen = agentOpensTab("agent-a", "https://seen.test/");
    useBrowserProvenanceStore.getState().humanUsed({ browserId: seen.browserId });

    const result = await sweeperFor(main, { "agent-a": ARCHIVED }).sweep();

    expect(result).toEqual({ mode: "rehearse", wouldClose: [unseen.browserId], closed: [] });
    expect(main.logs).toEqual([
      {
        action: "would-close",
        browserId: unseen.browserId,
        workspaceId: WORKSPACE,
        reason: "creator-archived",
        creatorAgentId: "agent-a",
        idleHours: 0,
        host: "unseen.test",
      },
    ]);
    expect(layoutBrowserIds().sort()).toEqual([unseen.browserId, seen.browserId].sort());
    expect(useBrowserProvenanceStore.getState().recentlyClosedByWorkspace).toEqual({});

    // The same tab is not logged again on the next sweep the same day.
    await sweeperFor(main, { "agent-a": ARCHIVED }).sweep();
    expect(main.logs).toHaveLength(2);
  });

  test("when on, only the unseen tab closes and it can be reopened from recently closed", async () => {
    const main = new FakeMain();
    main.mode = "on";
    const unseen = agentOpensTab("agent-a", "https://unseen.test/page");
    useBrowserStore.getState().updateBrowser(unseen.browserId, { title: "Unseen page" });
    const seen = agentOpensTab("agent-a", "https://seen.test/");
    useBrowserProvenanceStore.getState().humanUsed({ browserId: seen.browserId });

    const result = await sweeperFor(main, { "agent-a": ARCHIVED }).sweep();

    expect(result.closed).toEqual([unseen.browserId]);
    expect(layoutBrowserIds()).toEqual([seen.browserId]);
    expect(getBrowserRecord(unseen.browserId)).toBeNull();
    expect(main.unregistered).toEqual([unseen.browserId]);
    expect(main.logs.map((entry) => entry.action)).toEqual(["closed"]);
    expect(useBrowserProvenanceStore.getState().recentlyClosedByWorkspace[KEY]).toEqual([
      expect.objectContaining({
        browserId: unseen.browserId,
        url: "https://unseen.test/page",
        title: "Unseen page",
        reason: "creator-archived",
      }),
    ]);

    expect(reopenRecentlyClosedBrowser({ workspaceKey: KEY, browserId: unseen.browserId })).toBe(
      true,
    );
    const reopened = layoutBrowserIds().find((id) => id !== seen.browserId) as string;
    expect(getBrowserRecord(reopened)?.url).toBe("https://unseen.test/page");
    expect(useBrowserProvenanceStore.getState().provenanceByBrowserId[reopened]).toMatchObject({
      openedBy: "human",
      humanTouched: true,
    });
    expect(useBrowserProvenanceStore.getState().recentlyClosedByWorkspace[KEY]).toEqual([]);
  });

  test("main's live state, a selected tab, a busy or unknown creator, and unknown origin all keep tabs", async () => {
    const main = new FakeMain();
    main.mode = "on";
    const onPhone = agentOpensTab("agent-a", "https://phone.test/");
    main.blockers[onPhone.browserId] = "held";
    const typed = agentOpensTab("agent-a", "https://typed.test/");
    main.blockers[typed.browserId] = "edited";
    const selected = agentOpensTab("agent-a", "https://selected.test/");
    useWorkspaceLayoutStore.getState().focusTab(KEY, selected.tabId);
    const busy = agentOpensTab("agent-busy", "https://busy.test/");
    const unknown = agentOpensTab("agent-unreachable", "https://unknown.test/");
    const legacyId = useBrowserStore.getState().createBrowser({ initialUrl: "https://old.test/" });
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(KEY, { kind: "browser", browserId: legacyId });
    const later = Date.now() + 48 * HOUR;

    const result = await sweeperFor(
      main,
      {
        "agent-a": ARCHIVED,
        "agent-busy": { status: "idle", backgroundWaits: { pending: 1 } },
        "agent-unreachable": "throws",
      },
      () => later,
    ).sweep();

    expect(result).toEqual({ mode: "on", wouldClose: [], closed: [] });
    expect(layoutBrowserIds().sort()).toEqual(
      [
        onPhone.browserId,
        typed.browserId,
        selected.browserId,
        busy.browserId,
        unknown.browserId,
        legacyId,
      ].sort(),
    );
  });

  test("an idle creator's tab closes only after 24 hours without its browser commands", async () => {
    const main = new FakeMain();
    main.mode = "on";
    const opened = agentOpensTab("agent-a", "https://idle.test/");
    const idle: BrowserAutoCloseCreatorSnapshot = { status: "idle" };
    const start = Date.now();

    expect(
      (await sweeperFor(main, { "agent-a": idle }, () => start + 23 * HOUR).sweep()).closed,
    ).toEqual([]);
    expect(
      (await sweeperFor(main, { "agent-a": idle }, () => start + 25 * HOUR).sweep()).closed,
    ).toEqual([opened.browserId]);
  });

  test("off closes and logs nothing", async () => {
    const main = new FakeMain();
    main.mode = "off";
    agentOpensTab("agent-a", "https://off.test/");
    expect(await sweeperFor(main, { "agent-a": ARCHIVED }).sweep()).toEqual({
      mode: "off",
      wouldClose: [],
      closed: [],
    });
    expect(main.logs).toEqual([]);
  });
});
