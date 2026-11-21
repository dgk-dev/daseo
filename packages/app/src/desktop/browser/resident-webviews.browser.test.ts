import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInactiveBrowserWebviewViewport,
  type BrowserWebviewProfileHost,
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  getBrowserRegistrationStage,
  getPresentedBrowserPaneSize,
  parkBrowserWebview,
  getResidentBrowserWebview,
  prepareBrowserWebview,
  presentBrowserWebview,
  rememberBrowserWebviewSize,
  releaseResidentBrowserWebview,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
  takeResidentBrowserWebview,
  waitForBrowserRegistration,
} from "./resident-webviews";
import {
  setCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "../../utils/command-center-focus-restore";

const RESIDENT_HOST_ID = "paseo-browser-resident-webviews";
const attachedBrowsers: Array<{
  browserId: string;
  workspaceId: string;
  webContentsId: number;
  requestedUrl?: string;
}> = [];
const profileHost: BrowserWebviewProfileHost = {
  profilePartition: "persist:paseo-browser",
  registerAttachedBrowser: async (input) => {
    attachedBrowsers.push(input);
  },
};

function ensureTestBrowser(input: {
  browserId: string;
  workspaceId: string;
  url: string;
}): HTMLElement | null {
  return ensureResidentBrowserWebview({ ...input, profileHost });
}

function prepareTestBrowser(
  webview: HTMLElement,
  input: { browserId: string; workspaceId: string; initialUrl?: string | null },
): void {
  prepareBrowserWebview(webview, { ...input, profileHost });
}

function residentHost(): HTMLElement {
  const host = document.getElementById(RESIDENT_HOST_ID);
  if (!host) {
    throw new Error("Expected resident browser host");
  }
  return host;
}

function expectPermanentHostParking(host: HTMLElement): void {
  expect(host.style.position).toBe("fixed");
  expect(host.style.left).toBe("0px");
  expect(host.style.top).toBe("0px");
  expect(host.style.width).toBe("100vw");
  expect(host.style.height).toBe("100vh");
  expect(host.style.overflow).toBe("visible");
  expect(host.style.opacity).toBe("1");
  expect(host.style.pointerEvents).toBe("none");
  expect(host.style.display).toBe("block");
  expect(host.style.zIndex).toBe("0");
}

function expectParkedSurface(surface: HTMLElement): void {
  expect(surface.getAttribute("aria-hidden")).toBe("true");
  expect(surface.style.position).toBe("fixed");
  expect(surface.style.left).toBe("0px");
  expect(surface.style.top).toBe("0px");
  expect(surface.style.width).toBe("1px");
  expect(surface.style.height).toBe("1px");
  expect(surface.style.overflow).toBe("hidden");
  expect(surface.style.opacity).toBe("1");
  expect(surface.style.pointerEvents).toBe("none");
  expect(surface.style.display).toBe("block");
  expect(surface.style.visibility).toBe("visible");
  expect(surface.style.transform).toBe("");
}

function expectResidentWebviewParking(webview: HTMLElement): void {
  expect(webview.style.display).toBe("inline-flex");
  expect(webview.style.flex).toBe("0 0 auto");
  expect(webview.style.width).toBe("1280px");
  expect(webview.style.height).toBe("800px");
  expect(webview.style.position).toBe("absolute");
  expect(webview.style.left).toBe("0px");
  expect(webview.style.top).toBe("0px");
  expect(webview.style.zIndex).toBe("0");
}

describe("resident browser webviews", () => {
  beforeEach(() => {
    attachedBrowsers.length = 0;
  });

  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
  });

  it("parks a browser webview in the permanent paintable 1x1 host", () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);

    releaseResidentBrowserWebview("browser-a", webview);

    const host = residentHost();
    expect(visibleHost.children).toHaveLength(0);
    const surface = host.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([webview]);
    expect(webview.isConnected).toBe(true);
    expectPermanentHostParking(host);
    expectParkedSurface(surface);
    expectResidentWebviewParking(webview);
  });

  it("presents and parks a browser without changing its webview parent", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-stable-parent",
      workspaceId: "workspace-stable-parent",
      url: "https://example.com",
    });
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const permanentParent = webview.parentElement;

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
    expect(permanentParent.style.left).toBe("40px");
    expect(permanentParent.style.top).toBe("60px");
    expect(permanentParent.style.width).toBe("640px");
    expect(permanentParent.style.height).toBe("480px");
    expect(permanentParent.style.pointerEvents).toBe("auto");
    expect(permanentParent.getAttribute("aria-hidden")).toBe("false");
    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");

    expect(
      ensureTestBrowser({
        browserId: "browser-stable-parent",
        workspaceId: "workspace-stable-parent",
        url: "https://example.com",
      }),
    ).toBe(webview);
    expect(permanentParent.style.width).toBe("640px");
    expect(permanentParent.style.height).toBe("480px");
    expect(permanentParent.style.pointerEvents).toBe("auto");

    releaseResidentBrowserWebview("browser-stable-parent", webview);
    expect(webview.parentElement).toBe(permanentParent);
    expectParkedSurface(permanentParent);

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
  });

  it("clips an oversized fixed viewport to its pane without resizing the webview", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-oversized",
      workspaceId: "workspace-oversized",
      url: "https://example.com",
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: -800, top: -300, width: 2560, height: 1440 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 150, width: 800, height: 600 }),
    });

    presentBrowserWebview("browser-oversized", webview, anchor, clip, {
      mode: "fixed",
      width: 2560,
      height: 1440,
    });

    expect(webview.parentElement.style.left).toBe("100px");
    expect(webview.parentElement.style.top).toBe("150px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.style.width).toBe("2560px");
    expect(webview.style.height).toBe("1440px");

    resizeResidentBrowserWebview({ browserId: "browser-oversized", width: 2560, height: 1440 });

    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
  });

  it("creates a resident webview for an agent-created unfocused tab", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-agent",
      workspaceId: "workspace-agent",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expect(webview?.isConnected).toBe(true);
    expect(webview?.getAttribute("data-paseo-browser-id")).toBe("browser-agent");
    expect(webview?.getAttribute("partition")).toBe("persist:paseo-browser");
    expect((webview as HTMLUnknownElement & { src?: string })?.src).toContain(
      "https://example.com",
    );
    expectPermanentHostParking(residentHost());
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("shares one profile and registers attached guests with explicit identity", () => {
    const firstWebview = ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-a",
      url: "https://example.com/first",
    });
    const secondWebview = ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-b",
      url: "https://example.com/second",
    });
    if (!firstWebview || !secondWebview) {
      throw new Error("Expected resident webviews");
    }
    Object.assign(firstWebview, { getWebContentsId: () => 101 });
    Object.assign(secondWebview, { getWebContentsId: () => 202 });

    firstWebview.dispatchEvent(new Event("did-attach"));
    secondWebview.dispatchEvent(new Event("did-attach"));

    expect(firstWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(secondWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(attachedBrowsers).toEqual([
      {
        browserId: "browser-first",
        workspaceId: "workspace-a",
        webContentsId: 101,
        requestedUrl: "https://example.com/first",
      },
      {
        browserId: "browser-second",
        workspaceId: "workspace-b",
        webContentsId: 202,
        requestedUrl: "https://example.com/second",
      },
    ]);
  });

  it("waits for dom-ready when Electron exposes the guest identity after did-attach", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-delayed-identity",
      workspaceId: "workspace-delayed-identity",
      url: "https://example.com/delayed",
    });
    if (!webview) throw new Error("Expected resident webview");

    let ready = false;
    Object.assign(webview, {
      getWebContentsId: () => {
        if (!ready) throw new Error("guest is not ready");
        return 303;
      },
    });

    webview.dispatchEvent(new Event("did-attach"));
    expect(attachedBrowsers).toEqual([]);

    ready = true;
    webview.dispatchEvent(new Event("dom-ready"));
    expect(attachedBrowsers).toEqual([
      {
        browserId: "browser-delayed-identity",
        workspaceId: "workspace-delayed-identity",
        webContentsId: 303,
        requestedUrl: "https://example.com/delayed",
      },
    ]);
  });

  // Delta 123: Electron 44 makes the identity legal one task after did-attach; a tab whose first
  // document is slow never reaches dom-ready within browser_new_tab's deadline.
  it("registers one task after did-attach without waiting for dom-ready", async () => {
    const webview = ensureTestBrowser({
      browserId: "browser-next-task",
      workspaceId: "workspace-next-task",
      url: "https://example.com/slow?token=secret",
    });
    if (!webview) throw new Error("Expected resident webview");
    let reads = 0;
    Object.assign(webview, {
      getWebContentsId: () => {
        reads += 1;
        if (reads === 1) throw new Error("guest is not ready");
        return 404;
      },
    });

    webview.dispatchEvent(new Event("did-attach"));
    expect(attachedBrowsers).toEqual([]);
    expect(getBrowserRegistrationStage("browser-next-task")).toBe("waiting-for-identity");

    const result = await waitForBrowserRegistration("browser-next-task", { timeoutMs: 1000 });
    expect(result).toEqual(expect.objectContaining({ ok: true, stage: "registered" }));
    expect(attachedBrowsers).toEqual([
      {
        browserId: "browser-next-task",
        workspaceId: "workspace-next-task",
        webContentsId: 404,
        requestedUrl: "https://example.com/slow?token=secret",
      },
    ]);
  });

  it("hands main's rejection to the waiter with its reason", async () => {
    const rejectingHost: BrowserWebviewProfileHost = {
      profilePartition: "persist:paseo-browser",
      registerAttachedBrowser: async () => {
        throw new Error("Attached browser registration was rejected: guest destroyed");
      },
    };
    const webview = ensureResidentBrowserWebview({
      browserId: "browser-rejected",
      workspaceId: "workspace-rejected",
      url: "https://example.com/",
      profileHost: rejectingHost,
    });
    if (!webview) throw new Error("Expected resident webview");
    Object.assign(webview, { getWebContentsId: () => 505 });

    webview.dispatchEvent(new Event("did-attach"));
    const result = await waitForBrowserRegistration("browser-rejected", { timeoutMs: 1000 });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        stage: "rejected",
        reason: "Attached browser registration was rejected: guest destroyed",
      }),
    );
  });

  it("names the stage still pending at the deadline", async () => {
    ensureTestBrowser({
      browserId: "browser-never-attached",
      workspaceId: "workspace-never-attached",
      url: "https://example.com/",
    });

    const result = await waitForBrowserRegistration("browser-never-attached", { timeoutMs: 20 });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        stage: "waiting-for-attach",
        reason: "still waiting for attach after 20ms",
      }),
    );
  });

  it("a registration answer after the tab was removed does not revive it", async () => {
    let answer: (() => void) | null = null;
    const slowHost: BrowserWebviewProfileHost = {
      profilePartition: "persist:paseo-browser",
      registerAttachedBrowser: (input) =>
        new Promise<void>((resolve) => {
          answer = () => {
            attachedBrowsers.push(input);
            resolve();
          };
        }),
    };
    const webview = ensureResidentBrowserWebview({
      browserId: "browser-late",
      workspaceId: "workspace-late",
      url: "https://example.com/",
      profileHost: slowHost,
    });
    if (!webview) throw new Error("Expected resident webview");
    Object.assign(webview, { getWebContentsId: () => 606 });
    webview.dispatchEvent(new Event("did-attach"));
    const waiting = waitForBrowserRegistration("browser-late", { timeoutMs: 1000 });

    removeResidentBrowserWebview("browser-late");
    expect(await waiting).toEqual(
      expect.objectContaining({ ok: false, stage: "removed", reason: "tab removed" }),
    );
    if (!answer) throw new Error("Expected a pending registration");
    (answer as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getBrowserRegistrationStage("browser-late")).toBeNull();
    expect(getResidentBrowserWebview("browser-late")).toBeNull();
  });

  it("normalizes an existing resident host back to permanent parking", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";
    document.body.appendChild(staleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-stale-host",
      workspaceId: "workspace-stale-host",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expectPermanentHostParking(staleHost);
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("normalizes an existing resident webview and its stale host before reusing them", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";

    const staleWebview = document.createElement("webview");
    prepareTestBrowser(staleWebview, {
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      initialUrl: "https://example.com",
    });
    staleWebview.style.display = "none";
    staleWebview.style.width = "1px";
    staleWebview.style.height = "1px";
    staleWebview.style.position = "fixed";
    staleWebview.style.left = "-20000px";
    staleHost.appendChild(staleWebview);
    document.body.appendChild(staleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(staleWebview);
    const surface = staleHost.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([staleWebview]);
    expectPermanentHostParking(staleHost);
    expectParkedSurface(surface);
    expectResidentWebviewParking(staleWebview);
  });

  it("parks resident webviews as an overlapping stack", () => {
    const firstWebview = ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-stack",
      url: "https://example.com/first",
    });
    const secondWebview = ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-stack",
      url: "https://example.com/second",
    });

    const host = residentHost();
    expect(firstWebview?.parentElement?.parentElement).toBe(host);
    expect(secondWebview?.parentElement?.parentElement).toBe(host);
    expect(firstWebview?.parentElement).not.toBe(secondWebview?.parentElement);
    expectResidentWebviewParking(firstWebview as HTMLElement);
    expectResidentWebviewParking(secondWebview as HTMLElement);
  });

  it("returns a resident webview without detaching it from its permanent surface", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-visible",
      workspaceId: "workspace-visible",
      url: "https://example.com",
    });

    const permanentParent = webview?.parentElement;
    const visibleWebview = takeResidentBrowserWebview("browser-visible");

    expect(visibleWebview).toBe(webview);
    expect(webview?.parentElement).toBe(permanentParent);
    expect(takeResidentBrowserWebview("browser-visible")).toBe(webview);
  });

  it("applies an exact fixed viewport without a flex width override", () => {
    const webview = document.createElement("webview");
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });

    presentBrowserWebview("browser-fixed", webview, anchor, clip, {
      mode: "fixed",
      width: 640,
      height: 480,
    });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("parks a browser at its last resolved viewport dimensions", () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);
    rememberBrowserWebviewSize({ browserId: "browser-sized", width: 640, height: 480 });

    releaseResidentBrowserWebview("browser-sized", webview);

    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("returns a parked Responsive browser to the resident 1280x800", () => {
    const webview = document.createElement("webview");
    rememberBrowserWebviewSize({ browserId: "browser-inactive", width: 640, height: 480 });

    applyInactiveBrowserWebviewViewport("browser-inactive", webview, { mode: "responsive" });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("1280px");
    expect(webview.style.height).toBe("800px");
  });

  it("follows the pane while presented and forgets its size once parked", () => {
    const anchor = document.createElement("div");
    anchor.style.position = "fixed";
    anchor.style.left = "10px";
    anchor.style.top = "20px";
    anchor.style.width = "612px";
    anchor.style.height = "540px";
    document.body.appendChild(anchor);
    const webview = document.createElement("webview");
    releaseResidentBrowserWebview("browser-follow", webview);
    expect(getPresentedBrowserPaneSize("browser-follow")).toBeNull();

    presentBrowserWebview("browser-follow", webview, anchor, anchor, { mode: "responsive" });
    rememberBrowserWebviewSize({ browserId: "browser-follow", width: 612, height: 540 });
    expect(webview.style.width).toBe("612px");
    expect(webview.style.height).toBe("540px");
    expect(getPresentedBrowserPaneSize("browser-follow")).toEqual({ width: 612, height: 540 });

    parkBrowserWebview("browser-follow", webview, { mode: "responsive" });
    expect(webview.style.width).toBe("1280px");
    expect(webview.style.height).toBe("800px");
    expect(getPresentedBrowserPaneSize("browser-follow")).toBeNull();

    // A later park of the same background tab (another pane mounting) stays at the default.
    releaseResidentBrowserWebview("browser-follow", webview);
    expect(webview.style.width).toBe("1280px");
    anchor.remove();
  });

  it("keeps a fixed viewport when its pane parks it", () => {
    const webview = document.createElement("webview");
    rememberBrowserWebviewSize({ browserId: "browser-fixed", width: 640, height: 480 });

    parkBrowserWebview("browser-fixed", webview, { mode: "fixed", width: 390, height: 844 });

    expect(webview.style.width).toBe("390px");
    expect(webview.style.height).toBe("844px");
  });

  it("parks a cold inactive browser at its canonical fixed viewport", () => {
    const webview = document.createElement("webview");

    applyInactiveBrowserWebviewViewport("browser-restored-fixed", webview, {
      mode: "fixed",
      width: 800,
      height: 600,
    });

    expect(webview.style.width).toBe("800px");
    expect(webview.style.height).toBe("600px");
  });

  it("returns an existing visible pane webview instead of creating a resident duplicate", () => {
    const visibleHost = document.createElement("div");
    const visibleWebview = document.createElement("webview");
    prepareTestBrowser(visibleWebview, {
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      initialUrl: "https://example.com",
    });
    visibleHost.appendChild(visibleWebview);
    document.body.appendChild(visibleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(visibleWebview);
    expect(document.getElementById(RESIDENT_HOST_ID)).toBeNull();
  });

  it("finds the originating browser webview for focus restoration", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-focus",
      workspaceId: "workspace-focus",
      url: "https://example.com",
    });

    setCommandCenterFocusRestoreElement(getResidentBrowserWebview("browser-focus"));

    expect(takeCommandCenterFocusRestoreElement()).toBe(webview);

    expect(getResidentBrowserWebview("browser-missing")).toBeNull();
  });

  it("removes a resident webview when its browser tab closes", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-closed",
      workspaceId: "workspace-closed",
      url: "https://example.com",
    });

    removeResidentBrowserWebview("browser-closed");

    expect(webview?.isConnected).toBe(false);
    expect(takeResidentBrowserWebview("browser-closed")).toBeNull();
  });
});
