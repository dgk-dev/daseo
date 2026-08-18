import { describe, expect, test } from "vitest";
import {
  BrowserPopupTargetManager,
  type BrowserPopupBounds,
  type BrowserPopupContentsEvent,
  type BrowserPopupContentsPort,
  type BrowserPopupHostViewPort,
  type BrowserPopupTargetRegistration,
  type BrowserPopupTargetsSnapshot,
  type BrowserPopupViewPort,
} from "./popup-targets.js";

class FakePopupContents implements BrowserPopupContentsPort {
  public url = "https://login.example.com/start";
  public title = "Sign in";
  public loading = false;
  public canBack = false;
  public canForward = false;
  public focusCalls = 0;
  public closeCalls = 0;
  private destroyed = false;
  private readonly listeners = new Map<BrowserPopupContentsEvent, Array<() => void>>();

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getURL(): string {
    return this.url;
  }

  public getTitle(): string {
    return this.title;
  }

  public isLoading(): boolean {
    return this.loading;
  }

  public canGoBack(): boolean {
    return this.canBack;
  }

  public canGoForward(): boolean {
    return this.canForward;
  }

  public focus(): void {
    this.focusCalls += 1;
    this.emit("focus");
  }

  public close(): void {
    this.closeCalls += 1;
    this.destroy();
  }

  public subscribe(event: BrowserPopupContentsEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  public emit(event: BrowserPopupContentsEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakePopupView implements BrowserPopupViewPort {
  public readonly bounds: BrowserPopupBounds[] = [];
  public readonly visibility: boolean[] = [];

  public constructor(public readonly contents: FakePopupContents) {}

  public setBounds(bounds: BrowserPopupBounds): void {
    this.bounds.push({ ...bounds });
  }

  public setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }
}

class FakeHostView implements BrowserPopupHostViewPort {
  public readonly children: BrowserPopupViewPort[] = [];
  public readonly removed: BrowserPopupViewPort[] = [];
  public readonly visibility: Array<{ view: BrowserPopupViewPort; visible: boolean }> = [];

  public addChildView(view: BrowserPopupViewPort): void {
    this.children.push(view);
  }

  public setChildViewVisible(view: BrowserPopupViewPort, visible: boolean): void {
    this.visibility.push({ view, visible });
  }

  public removeChildView(view: BrowserPopupViewPort): void {
    this.removed.push(view);
    const index = this.children.indexOf(view);
    if (index >= 0) this.children.splice(index, 1);
  }
}

class PopupManagerHarness {
  public readonly registrations: BrowserPopupTargetRegistration[] = [];
  public readonly unregistered: string[] = [];
  public readonly activeTargets: Array<{
    browserId: string;
    workspaceId: string;
    hostWebContentsId: number;
  }> = [];
  public readonly snapshots: BrowserPopupTargetsSnapshot[] = [];
  public readonly host = new FakeHostView();
  private nextId = 1;
  private nowValue = 1_000;
  public readonly manager: BrowserPopupTargetManager;

  public constructor(
    options: {
      maxTargetsPerRoot?: number;
      maxTargetsPerHost?: number;
      openBurstLimit?: number;
      openBurstWindowMs?: number;
    } = {},
  ) {
    this.manager = new BrowserPopupTargetManager({
      createBrowserId: () => `popup-${this.nextId++}`,
      now: () => this.nowValue,
      ...options,
      onRegisterTarget: (registration) => this.registrations.push(registration),
      onUnregisterTarget: (browserId) => this.unregistered.push(browserId),
      onSetActiveTarget: (target) => this.activeTargets.push(target),
      onSnapshot: (snapshot) => this.snapshots.push(snapshot),
    });
  }

  public advance(ms: number): void {
    this.nowValue += ms;
  }

  public bind(
    input: {
      rootWebContentsId?: number;
      rootBrowserId?: string;
      workspaceId?: string;
      hostWebContentsId?: number;
    } = {},
  ): void {
    this.manager.bindRoot({
      rootWebContentsId: input.rootWebContentsId ?? 100,
      rootBrowserId: input.rootBrowserId ?? "browser-root",
      workspaceId: input.workspaceId ?? "workspace-a",
      hostWebContentsId: input.hostWebContentsId ?? 10,
    });
  }

  public adopt(
    input: {
      contentsId?: number;
      rootWebContentsId?: number;
      openerWebContentsId?: number;
      hostWebContentsId?: number;
      requestActivation?: boolean;
      initialBounds?: Partial<BrowserPopupBounds>;
    } = {},
  ): { browserId: string; contents: FakePopupContents; view: FakePopupView } {
    const contents = new FakePopupContents(input.contentsId ?? 200 + this.host.children.length);
    const view = new FakePopupView(contents);
    const browserId = this.manager.adopt({
      rootWebContentsId: input.rootWebContentsId ?? 100,
      openerWebContentsId: input.openerWebContentsId ?? 100,
      hostWebContentsId: input.hostWebContentsId ?? 10,
      disposition: "new-window",
      view,
      hostView: this.host,
      ...(input.requestActivation ? { requestActivation: true } : {}),
      ...(input.initialBounds ? { initialBounds: input.initialBounds } : {}),
    });
    return { browserId, contents, view };
  }
}

const PRESENTED_BOUNDS = { x: 20, y: 80, width: 900, height: 640 };

describe("BrowserPopupTargetManager", () => {
  test("adopts the Chromium popup hidden without creating an OS window", () => {
    const harness = new PopupManagerHarness();
    harness.bind();

    const popup = harness.adopt({ initialBounds: { width: 500, height: 700 } });

    expect(popup.browserId).toBe("popup-1");
    expect(popup.view.visibility).toEqual([]);
    expect(popup.view.bounds).toEqual([{ x: 0, y: 0, width: 500, height: 700 }]);
    expect(harness.host.children).toEqual([popup.view]);
    expect(harness.registrations).toEqual([
      {
        browserId: "popup-1",
        rootBrowserId: "browser-root",
        openerBrowserId: "browser-root",
        workspaceId: "workspace-a",
        hostWebContentsId: 10,
        webContentsId: popup.contents.id,
      },
    ]);
  });

  test("holds an early popup until its root webview identity binds", () => {
    const harness = new PopupManagerHarness();
    const popup = harness.adopt({ requestActivation: true });

    expect(harness.registrations).toEqual([]);
    expect(harness.snapshots).toEqual([]);

    harness.bind();

    expect(harness.registrations).toEqual([
      expect.objectContaining({ browserId: popup.browserId, rootBrowserId: "browser-root" }),
    ]);
    expect(harness.snapshots.at(-1)).toEqual(
      expect.objectContaining({
        reason: "bound",
        rootBrowserId: "browser-root",
        activationBrowserId: popup.browserId,
        targets: [expect.objectContaining({ browserId: popup.browserId })],
      }),
    );
  });

  test("resolves nested opener ownership even when both popups predate root binding", () => {
    const harness = new PopupManagerHarness();
    const first = harness.adopt({ contentsId: 201 });
    const second = harness.adopt({ contentsId: 202, openerWebContentsId: 201 });

    harness.bind();

    expect(harness.registrations).toEqual([
      expect.objectContaining({ browserId: first.browserId, openerBrowserId: "browser-root" }),
      expect.objectContaining({ browserId: second.browserId, openerBrowserId: first.browserId }),
    ]);
  });

  test("records the direct opener for nested popups", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const first = harness.adopt({ contentsId: 201 });
    const second = harness.adopt({ contentsId: 202, openerWebContentsId: 201 });

    expect(harness.registrations).toEqual([
      expect.objectContaining({ browserId: first.browserId, openerBrowserId: "browser-root" }),
      expect.objectContaining({ browserId: second.browserId, openerBrowserId: first.browserId }),
    ]);
  });

  test("emits a one-shot activation request only for the popup that requested it", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const background = harness.adopt();
    const foreground = harness.adopt({ requestActivation: true });

    expect(harness.snapshots).toEqual([
      expect.objectContaining({ reason: "bound" }),
      expect.objectContaining({
        reason: "created",
        targets: [expect.objectContaining({ browserId: background.browserId })],
      }),
      expect.objectContaining({
        reason: "created",
        activationBrowserId: foreground.browserId,
      }),
    ]);
    expect(harness.snapshots[1]).not.toHaveProperty("activationBrowserId");
  });

  test("presents only one child target and restores the root as active when hidden", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const first = harness.adopt({ contentsId: 201 });
    const second = harness.adopt({ contentsId: 202 });

    expect(
      harness.manager.setPresentation({
        rootBrowserId: "browser-root",
        hostWebContentsId: 10,
        popupBrowserId: first.browserId,
        visible: true,
        bounds: PRESENTED_BOUNDS,
        focus: true,
      }),
    ).toBe(true);
    expect(harness.host.visibility).toEqual([{ view: first.view, visible: true }]);
    expect(first.contents.focusCalls).toBe(1);
    expect(harness.activeTargets.at(-1)).toEqual({
      browserId: first.browserId,
      workspaceId: "workspace-a",
      hostWebContentsId: 10,
    });

    harness.manager.setPresentation({
      rootBrowserId: "browser-root",
      hostWebContentsId: 10,
      popupBrowserId: second.browserId,
      visible: true,
      bounds: PRESENTED_BOUNDS,
    });
    expect(first.view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(second.view.bounds.at(-1)).toEqual(PRESENTED_BOUNDS);
    expect(harness.host.visibility.slice(-2)).toEqual([
      { view: first.view, visible: false },
      { view: second.view, visible: true },
    ]);

    harness.manager.setPresentation({
      rootBrowserId: "browser-root",
      hostWebContentsId: 10,
      popupBrowserId: second.browserId,
      visible: false,
    });
    expect(second.view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(harness.host.visibility.at(-1)).toEqual({ view: second.view, visible: false });
    expect(harness.activeTargets.at(-1)).toEqual({
      browserId: "browser-root",
      workspaceId: "workspace-a",
      hostWebContentsId: 10,
    });
  });

  test("does not refocus or reset identical presentation bounds during resize observation", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();

    for (let index = 0; index < 3; index += 1) {
      harness.manager.setPresentation({
        rootBrowserId: "browser-root",
        hostWebContentsId: 10,
        popupBrowserId: popup.browserId,
        visible: true,
        bounds: PRESENTED_BOUNDS,
      });
    }

    expect(popup.view.bounds).toEqual([{ x: 0, y: 0, width: 800, height: 600 }, PRESENTED_BOUNDS]);
    expect(harness.host.visibility).toEqual([{ view: popup.view, visible: true }]);
    expect(popup.contents.focusCalls).toBe(0);
  });

  test("rejects presentation from another window or for another root", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();

    expect(
      harness.manager.setPresentation({
        rootBrowserId: "browser-root",
        hostWebContentsId: 99,
        popupBrowserId: popup.browserId,
        visible: true,
        bounds: PRESENTED_BOUNDS,
      }),
    ).toBe(false);
    expect(
      harness.manager.setPresentation({
        rootBrowserId: "browser-other",
        hostWebContentsId: 10,
        popupBrowserId: popup.browserId,
        visible: true,
        bounds: PRESENTED_BOUNDS,
      }),
    ).toBe(false);
    expect(harness.host.visibility).toEqual([]);
  });

  test("publishes live navigation state without changing target identity", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();
    popup.contents.url = "https://login.example.com/consent";
    popup.contents.title = "Approve access";
    popup.contents.loading = true;
    popup.contents.canBack = true;
    popup.contents.emit("did-navigate");

    expect(harness.snapshots.at(-1)).toEqual(
      expect.objectContaining({
        reason: "updated",
        targets: [
          expect.objectContaining({
            browserId: popup.browserId,
            url: "https://login.example.com/consent",
            title: "Approve access",
            isLoading: true,
            canGoBack: true,
          }),
        ],
      }),
    );
  });

  test("visible target focus updates logical activity without focusing another workspace", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();
    harness.manager.setPresentation({
      rootBrowserId: "browser-root",
      hostWebContentsId: 10,
      popupBrowserId: popup.browserId,
      visible: true,
      bounds: PRESENTED_BOUNDS,
    });

    popup.contents.emit("focus");

    expect(harness.activeTargets.at(-1)).toEqual({
      browserId: popup.browserId,
      workspaceId: "workspace-a",
      hostWebContentsId: 10,
    });
    expect(harness.snapshots.at(-1)).toEqual(
      expect.objectContaining({ reason: "focused", focusedBrowserId: popup.browserId }),
    );
  });

  test("ignores focus emitted by a hidden background popup", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();
    const activeCount = harness.activeTargets.length;
    const snapshotCount = harness.snapshots.length;

    popup.contents.emit("focus");

    expect(harness.activeTargets).toHaveLength(activeCount);
    expect(harness.snapshots).toHaveLength(snapshotCount);
  });

  test("window.close removes the target, its native view, and automation registration", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();

    popup.contents.destroy();

    expect(harness.manager.getBrowserIdForWebContents(popup.contents.id)).toBeNull();
    expect(harness.host.children).toEqual([]);
    expect(harness.host.removed).toEqual([popup.view]);
    expect(harness.unregistered).toEqual([popup.browserId]);
    expect(harness.snapshots.at(-1)).toEqual(
      expect.objectContaining({ reason: "closed", targets: [] }),
    );
  });

  test("resizes a parked popup without changing human presentation", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();

    expect(
      harness.manager.resizeTarget({
        browserId: popup.browserId,
        hostWebContentsId: 10,
        width: 1024,
        height: 768,
      }),
    ).toEqual({ width: 1024, height: 768 });
    expect(popup.view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    expect(harness.host.visibility).toEqual([]);
  });

  test("keeps visible popup bounds while remembering its next parked viewport", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();
    harness.manager.setPresentation({
      rootBrowserId: "browser-root",
      hostWebContentsId: 10,
      popupBrowserId: popup.browserId,
      visible: true,
      bounds: PRESENTED_BOUNDS,
    });

    expect(
      harness.manager.resizeTarget({
        browserId: popup.browserId,
        hostWebContentsId: 10,
        width: 1024,
        height: 768,
      }),
    ).toEqual({ width: PRESENTED_BOUNDS.width, height: PRESENTED_BOUNDS.height });
    expect(popup.view.bounds.at(-1)).toEqual(PRESENTED_BOUNDS);
  });

  test("explicit close is scoped to the owning host window", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();

    expect(harness.manager.closeTarget({ browserId: popup.browserId, hostWebContentsId: 99 })).toBe(
      false,
    );
    expect(popup.contents.closeCalls).toBe(0);
    expect(harness.manager.closeTarget({ browserId: popup.browserId, hostWebContentsId: 10 })).toBe(
      true,
    );
    expect(popup.contents.closeCalls).toBe(1);
    expect(harness.unregistered).toEqual([popup.browserId]);
  });

  test("closing an opener root closes every nested popup and clears admission state", () => {
    const harness = new PopupManagerHarness({ openBurstLimit: 2 });
    harness.bind();
    const first = harness.adopt({ contentsId: 201 });
    const second = harness.adopt({ contentsId: 202, openerWebContentsId: 201 });
    expect(harness.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(true);
    expect(harness.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(true);
    expect(harness.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(false);

    harness.manager.closeRootByWebContents(100);

    expect(first.contents.closeCalls).toBe(1);
    expect(second.contents.closeCalls).toBe(1);
    expect(harness.host.children).toEqual([]);
    expect(harness.unregistered).toEqual([first.browserId, second.browserId]);
    expect(harness.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(true);
  });

  test("host teardown removes only targets owned by that Electron window", () => {
    const harness = new PopupManagerHarness();
    harness.bind({ rootWebContentsId: 100, rootBrowserId: "browser-a", hostWebContentsId: 10 });
    const first = harness.adopt({ rootWebContentsId: 100, hostWebContentsId: 10, contentsId: 201 });
    harness.bind({ rootWebContentsId: 101, rootBrowserId: "browser-b", hostWebContentsId: 20 });
    const second = harness.adopt({
      rootWebContentsId: 101,
      hostWebContentsId: 20,
      contentsId: 202,
    });

    harness.manager.closeHost(10);

    expect(first.contents.closeCalls).toBe(1);
    expect(second.contents.closeCalls).toBe(0);
    expect(
      harness.manager.getSnapshot({ rootBrowserId: "browser-b", hostWebContentsId: 20 }),
    ).toEqual(
      expect.objectContaining({
        targets: [expect.objectContaining({ browserId: second.browserId })],
      }),
    );
  });

  test("ignores late target events after window.close cleanup", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const popup = harness.adopt();
    popup.contents.destroy();
    const snapshotCount = harness.snapshots.length;

    popup.contents.title = "Stale title";
    popup.contents.emit("page-title-updated");
    popup.contents.emit("focus");

    expect(harness.snapshots).toHaveLength(snapshotCount);
    expect(harness.unregistered).toEqual([popup.browserId]);
  });

  test("replacing a reattached root closes stale popup targets for the same browser", () => {
    const harness = new PopupManagerHarness();
    harness.bind({ rootWebContentsId: 100 });
    const stale = harness.adopt({ rootWebContentsId: 100 });

    harness.bind({ rootWebContentsId: 101 });

    expect(stale.contents.closeCalls).toBe(1);
    expect(harness.unregistered).toEqual([stale.browserId]);
    expect(
      harness.manager.getSnapshot({ rootBrowserId: "browser-root", hostWebContentsId: 10 }),
    ).toEqual(expect.objectContaining({ targets: [] }));
  });

  test("enforces per-root, per-host, and burst limits independently", () => {
    const rootLimited = new PopupManagerHarness({ maxTargetsPerRoot: 1 });
    rootLimited.bind();
    expect(rootLimited.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(
      true,
    );
    rootLimited.adopt();
    expect(rootLimited.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(
      false,
    );

    const hostLimited = new PopupManagerHarness({ maxTargetsPerHost: 1 });
    hostLimited.bind();
    hostLimited.adopt();
    expect(hostLimited.manager.tryAdmit({ rootWebContentsId: 101, hostWebContentsId: 10 })).toBe(
      false,
    );

    const burstLimited = new PopupManagerHarness({ openBurstLimit: 1, openBurstWindowMs: 100 });
    expect(burstLimited.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(
      true,
    );
    expect(burstLimited.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(
      false,
    );
    burstLimited.advance(100);
    expect(burstLimited.manager.tryAdmit({ rootWebContentsId: 100, hostWebContentsId: 10 })).toBe(
      true,
    );
  });

  test("normalizes invalid popup geometry to a paintable bounded viewport", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const fallback = harness.adopt({ initialBounds: { width: 0, height: Number.NaN } });
    const clamped = harness.adopt({ initialBounds: { width: 10, height: 50_000 } });

    expect(fallback.view.bounds).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
    expect(clamped.view.bounds).toEqual([{ x: 0, y: 0, width: 120, height: 4096 }]);
  });

  test("rejects destroyed or duplicate popup WebContents", () => {
    const harness = new PopupManagerHarness();
    harness.bind();
    const contents = new FakePopupContents(201);
    const firstView = new FakePopupView(contents);
    harness.manager.adopt({
      rootWebContentsId: 100,
      openerWebContentsId: 100,
      hostWebContentsId: 10,
      disposition: "new-window",
      view: firstView,
      hostView: harness.host,
    });

    expect(() =>
      harness.manager.adopt({
        rootWebContentsId: 100,
        openerWebContentsId: 100,
        hostWebContentsId: 10,
        disposition: "new-window",
        view: new FakePopupView(contents),
        hostView: harness.host,
      }),
    ).toThrow("already managed");

    const destroyed = new FakePopupContents(202);
    destroyed.destroy();
    expect(() =>
      harness.manager.adopt({
        rootWebContentsId: 100,
        openerWebContentsId: 100,
        hostWebContentsId: 10,
        disposition: "new-window",
        view: new FakePopupView(destroyed),
        hostView: harness.host,
      }),
    ).toThrow("unavailable");
  });
});
