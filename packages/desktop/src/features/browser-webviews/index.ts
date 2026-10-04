import { webContents as allWebContents, type WebContents } from "electron";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry, type BrowserTargetMetadata } from "./registry.js";
import { BrowserTabLifecycle, type BrowserTabLifecycleTarget } from "./lifecycle.js";

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new PaseoBrowserWebviewRegistry();
const freezeExemptions: Array<(webContentsId: number) => boolean> = [];
const downloadsByWebContentsId = new Map<number, number>();
const browserTabLifecycle = new BrowserTabLifecycle({
  ...readLifecycleTimingOverride(process.env.PASEO_BROWSER_TAB_LIFECYCLE_MS),
  isFreezeBlocked: (webContentsId) =>
    (downloadsByWebContentsId.get(webContentsId) ?? 0) > 0 ||
    freezeExemptions.some((isExempt) => isExempt(webContentsId)),
  onError: (error, context) => {
    console.warn("[browser-lifecycle] transition failed", { ...context, error });
  },
  onTransition: (webContentsId, state) => {
    console.info(`[browser-lifecycle] ${state}`, {
      webContentsId,
      browserId: browserRegistry.getBrowserIdForWebContents(webContentsId),
    });
  },
});
// Renderer-reported pane presentation, keyed by host window and browser id: a pane can present a
// browser before its guest registers, so the hold is taken whenever both sides are known.
const presentedBrowserKeys = new Set<string>();
const presentationReleasesByWebContentsId = new Map<number, () => void>();

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  isLoading(): boolean;
  isCurrentlyAudible(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  once(event: "destroyed", listener: () => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserWebContentsIdentity;
  profileSession: object;
  findWebContents(webContentsId: number): RegisteredBrowserWebContents | null;
}

export function isPaseoBrowserWebviewAttach(input: { src?: string; partition?: string }): boolean {
  return (
    isAllowedBrowserWebviewUrl(input.src) && input.partition === PASEO_BROWSER_PROFILE_PARTITION
  );
}

export function listRegisteredPaseoBrowserIds(): string[] {
  return browserRegistry.listBrowserIds();
}

export function getPaseoBrowserWebviewRegistry(): PaseoBrowserWebviewRegistry {
  return browserRegistry;
}

// E2E seam: "<throttleAfterMs>,<freezeAfterMs>" shortens the two idle steps so a test can watch a
// tab freeze in seconds instead of fifteen minutes.
function readLifecycleTimingOverride(value: string | undefined): {
  throttleAfterMs?: number;
  freezeAfterMs?: number;
} {
  const [throttleAfterMs, freezeAfterMs] = (value ?? "").split(",").map((part) => Number(part));
  return Number.isFinite(throttleAfterMs) &&
    Number.isFinite(freezeAfterMs) &&
    throttleAfterMs > 0 &&
    freezeAfterMs > throttleAfterMs
    ? { throttleAfterMs, freezeAfterMs }
    : {};
}

export function getPaseoBrowserTabLifecycle(): BrowserTabLifecycle {
  return browserTabLifecycle;
}

/** Freeze exemptions owned by other modules, such as a running network capture. */
export function addPaseoBrowserFreezeExemption(isExempt: (webContentsId: number) => boolean): void {
  freezeExemptions.push(isExempt);
}

/** Counts a download a browser guest started; the returned callback marks it finished. */
export function trackPaseoBrowserDownload(webContentsId: number): () => void {
  downloadsByWebContentsId.set(
    webContentsId,
    (downloadsByWebContentsId.get(webContentsId) ?? 0) + 1,
  );
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const remaining = (downloadsByWebContentsId.get(webContentsId) ?? 1) - 1;
    if (remaining > 0) downloadsByWebContentsId.set(webContentsId, remaining);
    else downloadsByWebContentsId.delete(webContentsId);
  };
}

function toLifecycleTarget(contents: RegisteredBrowserWebContents): BrowserTabLifecycleTarget {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    isLoading: () => contents.isLoading(),
    isCurrentlyAudible: () => contents.isCurrentlyAudible(),
    setBackgroundThrottling: (allowed) => {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(allowed);
    },
    setWebLifecycleState: async (state) => {
      if (contents.isDestroyed()) return;
      // Automation attaches the same debugger on demand; nothing in the app detaches it.
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Page.setWebLifecycleState", { state });
    },
  };
}

export function preparePaseoBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  browserTabLifecycle.track(toLifecycleTarget(contents));
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
    browserTabLifecycle.untrack(webContentsId);
    presentationReleasesByWebContentsId.delete(webContentsId);
    downloadsByWebContentsId.delete(webContentsId);
  });
}

/**
 * The renderer reports when a pane starts or stops presenting a browser. A presented browser is
 * held active; one that leaves every pane starts its idle countdown.
 */
export function setPaseoBrowserPresented(input: {
  hostWebContentsId: number;
  browserId: string;
  presented: boolean;
}): void {
  const key = presentedBrowserKey(input.hostWebContentsId, input.browserId);
  if (input.presented) presentedBrowserKeys.add(key);
  else presentedBrowserKeys.delete(key);
  syncPresentationHold(input.hostWebContentsId, input.browserId);
}

/** Popup targets are native views; main knows their visibility directly. */
export function setPaseoBrowserContentsPresented(webContentsId: number, presented: boolean): void {
  const release = presentationReleasesByWebContentsId.get(webContentsId);
  if (presented && !release) {
    presentationReleasesByWebContentsId.set(webContentsId, browserTabLifecycle.hold(webContentsId));
  } else if (!presented && release) {
    presentationReleasesByWebContentsId.delete(webContentsId);
    release();
  }
}

function syncPresentationHold(hostWebContentsId: number, browserId: string): void {
  const webContentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (webContentsId !== null) {
    setPaseoBrowserContentsPresented(
      webContentsId,
      presentedBrowserKeys.has(presentedBrowserKey(hostWebContentsId, browserId)),
    );
  }
}

function presentedBrowserKey(hostWebContentsId: number, browserId: string): string {
  return `${hostWebContentsId}:${browserId}`;
}

export function registerAttachedPaseoBrowser(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.hostWebContents !== input.sender ||
    guest.session !== input.profileSession
  ) {
    return false;
  }

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  syncPresentationHold(input.sender.id, input.browserId);
  return true;
}

export function getPaseoBrowserIdForWebContents(
  contents: BrowserWebContentsIdentity | null,
): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function unregisterPaseoBrowser(browserId: string): void {
  browserRegistry.unregisterBrowser(browserId);
}

export function unregisterPaseoBrowserFromHost(hostWebContentsId: number, browserId: string): void {
  setPaseoBrowserPresented({ hostWebContentsId, browserId, presented: false });
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
}

export function unregisterPaseoBrowserHost(hostWebContentsId: number): void {
  const prefix = `${hostWebContentsId}:`;
  for (const key of presentedBrowserKeys) {
    if (key.startsWith(prefix)) {
      setPaseoBrowserPresented({
        hostWebContentsId,
        browserId: key.slice(prefix.length),
        presented: false,
      });
    }
  }
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
}

export function getPaseoBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function getPaseoBrowserTargetMetadata(browserId: string): BrowserTargetMetadata {
  return browserRegistry.getTargetMetadata(browserId);
}

export function registerManagedPaseoBrowserTarget(input: {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
  hostWebContentsId: number;
  metadata: BrowserTargetMetadata;
}): void {
  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.hostWebContentsId,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  browserRegistry.registerTargetMetadata(input.browserId, input.metadata);
}

export function listRegisteredPaseoBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry.listBrowserIdsForWorkspace(workspaceId);
}

export function setWorkspaceActivePaseoBrowserId(input: {
  hostWebContentsId: number;
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActivePaseoBrowserId(workspaceId: string): string | null {
  return browserRegistry.getMostRecentActiveBrowserIdForWorkspace(workspaceId);
}

export function getWorkspaceActivePaseoBrowserIdForHostWindow(
  workspaceId: string,
  hostWebContentsId: number,
): string | null {
  return browserRegistry.getActiveBrowserIdForWorkspaceInHostWindow(hostWebContentsId, workspaceId);
}

export function getPaseoBrowserWebContentsForHostWindow(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

export function getActivePaseoBrowserWebContentsForHostWindow(
  hostWebContentsId: number,
): WebContents | null {
  const browserId = browserRegistry.getActiveBrowserIdForHostWindow(hostWebContentsId);
  if (!browserId) {
    return null;
  }
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

function preventUnsafeBrowserWebviewNavigation(
  event: { preventDefault: () => void },
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
  }
}

export function registerBrowserWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-redirect", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
}
