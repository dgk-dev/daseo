import { execFile } from "node:child_process";
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
import { BrowserTabDiscarder, isEditingKeyInput } from "./discard.js";

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
// Tabs edited (by the user or an agent) since their last document load keep their page under
// memory pressure; a cross-document navigation clears the mark.
const editedWebContentsIds = new Set<number>();
const browserTabDiscarder = new BrowserTabDiscarder({
  lifecycle: browserTabLifecycle,
  readPressureLevel: readMacMemoryPressureLevel,
  isDiscardBlocked: isPaseoBrowserTabDiscardBlocked,
  onDiscard: (webContentsId, pressureLevel) => {
    console.info("[browser-lifecycle] discarded under memory pressure", {
      webContentsId,
      browserId: browserRegistry.getBrowserIdForWebContents(webContentsId),
      pressureLevel,
    });
  },
  onError: (error) => {
    console.warn("[browser-lifecycle] discard check failed", { error });
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

/** What discarding needs beyond the lifecycle basics; only plain browser tabs provide it. */
interface DiscardableBrowserWebContents extends RegisteredBrowserWebContents {
  forcefullyCrashRenderer(): void;
  reload(): void;
  isCrashed(): boolean;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string }>,
  ): Promise<unknown>;
  on(event: "did-stop-loading" | "did-navigate" | "dom-ready", listener: () => void): unknown;
  on(
    event: "before-input-event",
    listener: (event: unknown, input: { type: string; key: string }) => void,
  ): unknown;
  on(
    event: "context-menu",
    listener: (event: unknown, params: { isEditable: boolean }) => void,
  ): unknown;
  removeListener(event: "did-stop-loading" | "destroyed", listener: () => void): unknown;
}

const BROWSER_TAB_RESTORE_TIMEOUT_MS = 30_000;
const BROWSER_TAB_RESTORE_ATTEMPTS = 2;
// An isolated world of our own, so page scripts can neither see nor reset the mark.
const BROWSER_EDIT_WATCH_WORLD_ID = 1043;
const BROWSER_EDIT_CHECK_TIMEOUT_MS = 1_000;
// `input` and `change` fire only for edits a person makes (typing, paste from a menu, drag and
// drop, autofill, ticking a box, picking an option), never for a script setting a value. Both are
// composed, so edits inside shadow roots reach the document too.
const BROWSER_EDIT_WATCH_SCRIPT = `(() => {
  if (globalThis.__daseoEditWatch) return;
  globalThis.__daseoEditWatch = true;
  const mark = () => { globalThis.__daseoEdited = true; };
  document.addEventListener("input", mark, true);
  document.addEventListener("change", mark, true);
})()`;
// null when the watcher never ran in this document (it loaded before this build): unknown counts
// as edited.
const BROWSER_EDIT_READ_SCRIPT =
  "globalThis.__daseoEditWatch ? globalThis.__daseoEdited === true : null";

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

/** Starts the memory-pressure discard checks (macOS only; elsewhere the sysctl is absent). */
export function startPaseoBrowserTabDiscarder(): void {
  if (process.platform === "darwin") {
    browserTabDiscarder.start();
  }
}

/** An agent command that may leave unsaved input behind marks the tab like typing does. */
export function markPaseoBrowserEdited(webContentsId: number): void {
  editedWebContentsIds.add(webContentsId);
}

function readMacMemoryPressureLevel(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], (error, stdout) => {
      const level = Number(String(stdout).trim());
      resolve(error || !Number.isInteger(level) ? undefined : level);
    });
  });
}

/** Whether memory pressure must leave this tab's page alone (edited, downloading, shared). */
export function isPaseoBrowserTabDiscardBlocked(webContentsId: number): boolean {
  if (
    editedWebContentsIds.has(webContentsId) ||
    (downloadsByWebContentsId.get(webContentsId) ?? 0) > 0 ||
    freezeExemptions.some((isExempt) => isExempt(webContentsId))
  ) {
    return true;
  }
  const contents = allWebContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return true;
  }
  // Ending a renderer shared with another page would take that page down too.
  const pid = contents.getOSProcessId();
  if (!pid) {
    return true;
  }
  return allWebContents
    .getAllWebContents()
    .some(
      (other) =>
        other.id !== webContentsId && !other.isDestroyed() && other.getOSProcessId() === pid,
    );
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

function toLifecycleTarget(
  contents: RegisteredBrowserWebContents,
  discardable: DiscardableBrowserWebContents | null,
): BrowserTabLifecycleTarget {
  return {
    ...(discardable ? discardTarget(discardable) : {}),
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    isLoading: () => contents.isLoading(),
    isCurrentlyAudible: () => contents.isCurrentlyAudible(),
    setBackgroundThrottling: (allowed) => {
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(allowed);
    },
    setWebLifecycleState: async (state) => {
      if (contents.isDestroyed()) return;
      // Checked while the page still runs: a frozen page could not answer.
      if (state === "frozen" && discardable) await markIfPageWasEdited(discardable);
      // Automation attaches the same debugger on demand; nothing in the app detaches it.
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Page.setWebLifecycleState", { state });
    },
  };
}

function discardTarget(
  contents: DiscardableBrowserWebContents,
): Pick<BrowserTabLifecycleTarget, "discard" | "restore"> {
  return {
    discard: () => {
      if (!contents.isDestroyed()) contents.forcefullyCrashRenderer();
    },
    restore: async () => {
      for (let attempt = 0; attempt < BROWSER_TAB_RESTORE_ATTEMPTS; attempt += 1) {
        if (contents.isDestroyed()) {
          return;
        }
        await reloadAndWait(contents);
        // A page still loading after the wait has a live renderer, like any slow page; only a
        // renderer that never came back is tried again.
        if (contents.isDestroyed() || !contents.isCrashed()) {
          return;
        }
      }
      // Leaves the tab discarded, so the next wake tries again.
      throw new Error("browser tab renderer did not come back after reload");
    },
  };
}

async function reloadAndWait(contents: DiscardableBrowserWebContents): Promise<void> {
  // Settles on the first of: the reload finished, the tab closed, or the timeout.
  let onStop = () => {};
  let onDestroyed = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<void>((resolve) => {
    onStop = resolve;
  });
  const destroyed = new Promise<void>((resolve) => {
    onDestroyed = resolve;
  });
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BROWSER_TAB_RESTORE_TIMEOUT_MS);
  });
  contents.on("did-stop-loading", onStop);
  contents.once("destroyed", onDestroyed);
  try {
    contents.reload();
    await Promise.race([stopped, destroyed, timedOut]);
  } finally {
    clearTimeout(timer);
    contents.removeListener("did-stop-loading", onStop);
    contents.removeListener("destroyed", onDestroyed);
  }
}

async function markIfPageWasEdited(contents: DiscardableBrowserWebContents): Promise<void> {
  if (editedWebContentsIds.has(contents.id)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BROWSER_EDIT_CHECK_TIMEOUT_MS);
  });
  try {
    const edited = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(BROWSER_EDIT_WATCH_WORLD_ID, [
        { code: BROWSER_EDIT_READ_SCRIPT },
      ]),
      timedOut,
    ]);
    // A page that cannot answer is kept, not risked.
    if (edited !== false) editedWebContentsIds.add(contents.id);
  } catch {
    editedWebContentsIds.add(contents.id);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `discardable` is true for plain browser tabs (webview guests). Popup windows are never discarded:
 * reloading one can break the opener relationship an OAuth or payment flow depends on.
 */
export function preparePaseoBrowserWebContents(
  contents: RegisteredBrowserWebContents,
  options: { discardable?: boolean } = {},
): void {
  const webContentsId = contents.id;
  const discardable = options.discardable ? (contents as DiscardableBrowserWebContents) : null;
  browserTabLifecycle.track(toLifecycleTarget(contents, discardable));
  if (discardable) {
    discardable.on("before-input-event", (_event, input) => {
      if (isEditingKeyInput(input)) editedWebContentsIds.add(webContentsId);
    });
    // The context menu's Cut and Paste edit a field without a key press.
    discardable.on("context-menu", (_event, params) => {
      if (params.isEditable) editedWebContentsIds.add(webContentsId);
    });
    // Mouse-only edits (a ticked box, a picked option, a dropped file) are read from the page.
    discardable.on("dom-ready", () => {
      discardable
        .executeJavaScriptInIsolatedWorld(BROWSER_EDIT_WATCH_WORLD_ID, [
          { code: BROWSER_EDIT_WATCH_SCRIPT },
        ])
        .catch(() => {});
    });
    discardable.on("did-navigate", () => {
      editedWebContentsIds.delete(webContentsId);
    });
  }
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
    browserTabLifecycle.untrack(webContentsId);
    presentationReleasesByWebContentsId.delete(webContentsId);
    downloadsByWebContentsId.delete(webContentsId);
    editedWebContentsIds.delete(webContentsId);
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
