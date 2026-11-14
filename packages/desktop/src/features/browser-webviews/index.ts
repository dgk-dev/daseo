import { execFile } from "node:child_process";
import log from "electron-log/main";
import { webContents as allWebContents, type WebContents } from "electron";
import type { BrowserAutomationTabReportEntry } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry, type BrowserTargetMetadata } from "./registry.js";
import { BrowserTabLifecycle, type BrowserTabLifecycleTarget } from "./lifecycle.js";
import {
  BrowserTabDiscarder,
  isEditingKeyInput,
  type BrowserTabDiscardBlockReason,
} from "./discard.js";
import { PopupPaintHold } from "./popup-painting.js";
import { restoreDiscardedBrowserContents } from "./restore.js";
import { measureProcessFootprints } from "./renderer-footprint.js";

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new PaseoBrowserWebviewRegistry();
const freezeExemptions: Array<(webContentsId: number) => boolean> = [];
const downloadsByWebContentsId = new Map<number, number>();
const lifecycleTimingOverride = readLifecycleTimingOverride(
  process.env.PASEO_BROWSER_TAB_LIFECYCLE_MS,
);
const browserTabLifecycle = new BrowserTabLifecycle({
  ...(lifecycleTimingOverride.throttleAfterMs !== undefined
    ? {
        throttleAfterMs: lifecycleTimingOverride.throttleAfterMs,
        freezeAfterMs: lifecycleTimingOverride.freezeAfterMs,
      }
    : {}),
  isFreezeBlocked: (webContentsId) =>
    (downloadsByWebContentsId.get(webContentsId) ?? 0) > 0 ||
    freezeExemptions.some((isExempt) => isExempt(webContentsId)),
  onError: (error, context) => {
    log.warn("[browser-lifecycle] transition failed", { ...context, error });
  },
  onTransition: (webContentsId, state) => {
    log.info(`[browser-lifecycle] ${state}`, {
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
  isDiscardBlocked: getPaseoBrowserTabDiscardBlock,
  ...(lifecycleTimingOverride.idleDiscardAfterMs !== undefined
    ? { idleDiscardAfterMs: lifecycleTimingOverride.idleDiscardAfterMs }
    : {}),
  onDiscard: ({ webContentsId, idleMinutes, trigger }) => {
    const browserId = browserRegistry.getBrowserIdForWebContents(webContentsId);
    if (trigger.kind === "pressure") {
      log.info("[browser-lifecycle] discarded under memory pressure", {
        webContentsId,
        browserId,
        pressureLevel: trigger.pressureLevel,
        idleMinutes,
      });
    } else {
      // Delta 97: no memory pressure; unused past the idle time.
      log.info("[browser-lifecycle] discarded after idle", {
        webContentsId,
        browserId,
        idleMinutes,
      });
    }
  },
  // Delta 97: a candidate kept for a reason says why, once an hour per tab.
  onSkip: ({ webContentsId, idleMinutes, reason }) => {
    log.info("[browser-lifecycle] discard skipped", {
      browserId: browserRegistry.getBrowserIdForWebContents(webContentsId),
      webContentsId,
      reason,
      idleMinutes,
    });
  },
  onError: (error) => {
    log.warn("[browser-lifecycle] discard check failed", { error });
  },
});
// Renderer-reported pane presentation, keyed by host window and browser id: a pane can present a
// browser before its guest registers, so the hold is taken whenever both sides are known.
const presentedBrowserKeys = new Set<string>();
const presentationReleasesByWebContentsId = new Map<number, () => void>();
const popupPaintHoldsByWebContentsId = new Map<number, PopupPaintHold>();

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
    on?(event: "detach", listener: (event: unknown, reason: string) => void): unknown;
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
  removeListener(
    event: "dom-ready" | "did-stop-loading" | "destroyed",
    listener: () => void,
  ): unknown;
}

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

// E2E seam: "<throttleAfterMs>,<freezeAfterMs>[,<idleDiscardAfterMs>]" shortens the idle steps so
// a test can watch a tab freeze, and be discarded without memory pressure, in seconds. The idle
// discard time then wins over the desktop setting.
function readLifecycleTimingOverride(value: string | undefined): {
  throttleAfterMs?: number;
  freezeAfterMs?: number;
  idleDiscardAfterMs?: number;
} {
  const [throttleAfterMs, freezeAfterMs, idleDiscardAfterMs] = (value ?? "")
    .split(",")
    .map((part) => Number(part));
  if (
    !Number.isFinite(throttleAfterMs) ||
    !Number.isFinite(freezeAfterMs) ||
    throttleAfterMs <= 0 ||
    freezeAfterMs <= throttleAfterMs
  ) {
    return {};
  }
  return Number.isFinite(idleDiscardAfterMs) && idleDiscardAfterMs > freezeAfterMs
    ? { throttleAfterMs, freezeAfterMs, idleDiscardAfterMs }
    : { throttleAfterMs, freezeAfterMs };
}

export function getPaseoBrowserTabLifecycle(): BrowserTabLifecycle {
  return browserTabLifecycle;
}

/**
 * Starts the discard checks: under macOS memory pressure (elsewhere the sysctl is absent), and
 * after the idle time without it (delta 97).
 */
export function startPaseoBrowserTabDiscarder(): void {
  browserTabDiscarder.start();
}

/**
 * Delta 97: minutes a frozen tab may stay unused before it is discarded without memory pressure
 * (desktop setting `browser.discardIdleTabsAfterMinutes`, 0 = off). The E2E timing seam, when
 * set, wins.
 */
export function setPaseoBrowserTabIdleDiscardAfterMinutes(minutes: number): void {
  if (lifecycleTimingOverride.idleDiscardAfterMs !== undefined) return;
  browserTabDiscarder.setIdleDiscardAfterMs(minutes * 60_000);
}

/** One discard check now, as the 30-second timer runs it (the capture harness calls it). */
export function runPaseoBrowserTabDiscardCheck(): Promise<number> {
  return browserTabDiscarder.check();
}

/** An agent command that may leave unsaved input behind marks the tab like typing does. */
export function markPaseoBrowserEdited(webContentsId: number): void {
  editedWebContentsIds.add(webContentsId);
}

function readMacMemoryPressureLevel(): Promise<number | undefined> {
  if (process.platform !== "darwin") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], (error, stdout) => {
      const level = Number(String(stdout).trim());
      resolve(error || !Number.isInteger(level) ? undefined : level);
    });
  });
}

/**
 * Why a discard must leave this tab's page alone, or null when nothing does. The first reason
 * found wins, in this order.
 */
export function getPaseoBrowserTabDiscardBlock(
  webContentsId: number,
): BrowserTabDiscardBlockReason | null {
  const pageKeep = getPaseoBrowserPageKeepReason(webContentsId);
  if (pageKeep) return pageKeep;
  const contents = allWebContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return "destroyed";
  }
  // Ending a renderer shared with another page would take that page down too.
  const pid = contents.getOSProcessId();
  if (!pid) {
    return "no-pid";
  }
  const shared = allWebContents
    .getAllWebContents()
    .some(
      (other) =>
        other.id !== webContentsId && !other.isDestroyed() && other.getOSProcessId() === pid,
    );
  return shared ? "shared-renderer" : null;
}

/** What on the page itself must not be lost: typed-in input, a download, a capture or dialog. */
function getPaseoBrowserPageKeepReason(
  webContentsId: number,
): "edited" | "downloading" | "freeze-exempt" | null {
  if (editedWebContentsIds.has(webContentsId)) return "edited";
  if ((downloadsByWebContentsId.get(webContentsId) ?? 0) > 0) return "downloading";
  if (freezeExemptions.some((isExempt) => isExempt(webContentsId))) return "freeze-exempt";
  return null;
}

/** Why the agent-tab auto-close must leave a browser open (delta 98). */
export type BrowserCloseBlockReason =
  | "presented"
  | "held"
  | "edited"
  | "downloading"
  | "freeze-exempt"
  | "audible"
  | "popup-open";

/**
 * Delta 98: for each browser id, what live state keeps it open, or null when nothing does: a pane
 * shows it, something holds it awake (a command, capture, or phone stream), its page was typed
 * into, is downloading, capturing network, holding a dialog, or playing sound, or a popup it
 * opened is still open. A browser with no guest has no live state and gets null.
 */
export function getPaseoBrowserCloseBlocks(
  browserIds: readonly string[],
): Record<string, BrowserCloseBlockReason | null> {
  const blocks: Record<string, BrowserCloseBlockReason | null> = {};
  for (const browserId of browserIds) blocks[browserId] = null;
  const block = (browserId: string, reason: BrowserCloseBlockReason) => {
    if (blocks[browserId] === null) blocks[browserId] = reason;
  };
  for (const key of presentedBrowserKeys) {
    const browserId = key.slice(key.indexOf(":") + 1);
    if (browserId in blocks) block(browserId, "presented");
  }
  for (const entry of browserTabLifecycle.describe()) {
    const browserId = browserRegistry.getBrowserIdForWebContents(entry.webContentsId);
    if (!browserId) continue;
    const metadata = browserRegistry.getTargetMetadata(browserId);
    if (metadata.kind === "popup" && metadata.rootBrowserId && metadata.rootBrowserId in blocks) {
      block(metadata.rootBrowserId, "popup-open");
    }
    if (!(browserId in blocks)) continue;
    const contents = allWebContents.fromId(entry.webContentsId);
    if (!contents || contents.isDestroyed()) continue;
    if (entry.held) block(browserId, "held");
    const pageKeep = getPaseoBrowserPageKeepReason(entry.webContentsId);
    if (pageKeep) block(browserId, pageKeep);
    if (contents.isCurrentlyAudible()) block(browserId, "audible");
  }
  return blocks;
}

/**
 * Delta 97: every tracked tab with a browser id, its lifecycle state, renderer, memory, and what
 * would keep its page. Read-only: it holds, wakes, and marks nothing.
 */
export async function reportPaseoBrowserTabs(): Promise<{
  tabs: BrowserAutomationTabReportEntry[];
  discardIdleAfterMinutes: number;
  pressureLevel?: number;
}> {
  const now = Date.now();
  const rows = browserTabLifecycle.describe().flatMap((entry) => {
    const browserId = browserRegistry.getBrowserIdForWebContents(entry.webContentsId);
    const contents = allWebContents.fromId(entry.webContentsId);
    if (!browserId || !contents || contents.isDestroyed()) return [];
    // A discarded tab has no renderer; the id Electron still reports would be the ended one.
    const pid = entry.state === "discarded" ? 0 : contents.getOSProcessId();
    const kind = browserRegistry.getTargetMetadata(browserId).kind;
    const blockedBy = reportedDiscardBlock(entry);
    const workspaceId = browserRegistry.getWorkspaceId(browserId);
    const tab: BrowserAutomationTabReportEntry = {
      browserId,
      ...(workspaceId ? { workspaceId } : {}),
      kind,
      url: contents.getURL(),
      title: contents.getTitle(),
      state: entry.state,
      held: entry.held,
      idleMinutes: Math.max(0, Math.floor((now - entry.lastUsedAt) / 60_000)),
      ...(pid > 0 ? { rendererPid: pid } : {}),
      ...(blockedBy ? { discardBlockedBy: blockedBy } : {}),
    };
    return [{ pid, tab }];
  });
  const [footprints, pressureLevel] = await Promise.all([
    measureProcessFootprints([...new Set(rows.map((row) => row.pid).filter((pid) => pid > 0))]),
    readMacMemoryPressureLevel(),
  ]);
  for (const { pid, tab } of rows) {
    const footprintBytes = footprints.get(pid);
    if (footprintBytes !== undefined) tab.footprintBytes = footprintBytes;
  }
  return {
    tabs: rows.map((row) => row.tab),
    discardIdleAfterMinutes: browserTabDiscarder.getIdleDiscardAfterMs() / 60_000,
    ...(pressureLevel !== undefined ? { pressureLevel } : {}),
  };
}

/** What the report says keeps a tab's page: nothing for a discarded tab; popups are never discarded. */
function reportedDiscardBlock(entry: {
  webContentsId: number;
  state: string;
  discardable: boolean;
}): string | null {
  if (entry.state === "discarded") return null;
  if (!entry.discardable) return "popup";
  return getPaseoBrowserTabDiscardBlock(entry.webContentsId);
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
  paintHold: PopupPaintHold | null,
): BrowserTabLifecycleTarget {
  return {
    ...(discardable ? discardTarget(discardable) : {}),
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    isLoading: () => contents.isLoading(),
    isCurrentlyAudible: () => contents.isCurrentlyAudible(),
    // A popup never touches Electron's flag (delta 107, popup-painting.ts); awake is its paint hold.
    setBackgroundThrottling: (allowed) => {
      if (paintHold) paintHold.setAwake(!allowed);
      else if (!contents.isDestroyed()) contents.setBackgroundThrottling(allowed);
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
    restore: () => restoreDiscardedBrowserContents(contents),
  };
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

function createPopupPaintHold(contents: RegisteredBrowserWebContents): PopupPaintHold {
  const hold = new PopupPaintHold(
    {
      setFocusEmulation: async (enabled) => {
        if (contents.isDestroyed()) return;
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled });
      },
    },
    (error) => {
      if (!contents.isDestroyed()) {
        log.warn("[browser-popup] paint hold failed", { webContentsId: contents.id, error });
      }
    },
  );
  // Emulation state belongs to the debugger session; a new session starts without it. A closing
  // popup detaches with "target closed", and attaching again to it from here crashed the main
  // process (SIGSEGV), so only a live popup is re-held, after the detach has finished.
  contents.debugger.on?.("detach", (_event, reason) => {
    if (reason === "target closed") return;
    setImmediate(() => {
      if (!contents.isDestroyed()) hold.invalidate();
    });
  });
  return hold;
}

/**
 * `discardable` is true for plain browser tabs (webview guests). Popup windows are never discarded:
 * reloading one can break the opener relationship an OAuth or payment flow depends on. `popup`
 * marks an adopted popup window, which keeps painting while parked through its paint hold.
 */
export function preparePaseoBrowserWebContents(
  contents: RegisteredBrowserWebContents,
  options: { discardable?: boolean; popup?: boolean } = {},
): void {
  const webContentsId = contents.id;
  const discardable = options.discardable ? (contents as DiscardableBrowserWebContents) : null;
  const paintHold = options.popup ? createPopupPaintHold(contents) : null;
  if (paintHold) popupPaintHoldsByWebContentsId.set(webContentsId, paintHold);
  browserTabLifecycle.track(toLifecycleTarget(contents, discardable, paintHold));
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
    popupPaintHoldsByWebContentsId.get(webContentsId)?.dispose();
    popupPaintHoldsByWebContentsId.delete(webContentsId);
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
  popupPaintHoldsByWebContentsId.get(webContentsId)?.setPresented(presented);
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

/** The browser id and host window a tab or popup WebContents is registered under. */
export function getPaseoBrowserRegistrationForWebContents(
  webContentsId: number,
): { browserId: string; hostWebContentsId: number } | null {
  return browserRegistry.getRegistrationForWebContents(webContentsId);
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
