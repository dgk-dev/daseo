import type { Rectangle } from "electron";
import path from "node:path";
import { app, ipcMain, nativeImage, webContents as electronWebContents } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserAutomationConsoleLogEntry } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry } from "./service.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { collectElementStyles } from "./css-styles.js";
import {
  findWebFrame,
  listTabFrames,
  planFrameInputSteps,
  sendFrameInputThroughTarget,
  type WebFrameLike,
} from "./frame-input.js";
import {
  clearPaseoBrowserClientHintOverride,
  setPaseoBrowserClientHintOverride,
  userAgentDataPlatform,
} from "../browser-profile.js";
import {
  applyDeviceEmulation,
  deviceEmulationClientHints,
  type DeviceEmulationHost,
  resolveDeviceEmulation,
} from "./device-emulation.js";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import { getPaseoBrowserAgentDownloads } from "./downloads.js";
import { getPaseoBrowserTabEvents } from "./tab-events.js";
import {
  RENDERER_RECOVERY_COMMANDS,
  RendererHealthMonitor,
  describeRendererHealth,
} from "./renderer-health.js";
import {
  attachPaseoBrowserPageDialogs,
  getPaseoBrowserPageDialogs,
  installPaseoBrowserPromptRestorer,
  PAGE_DIALOG_SURFACE_EVENT,
  setPaseoBrowserPageDialogSurfacePorts,
  unwatchPaseoBrowserPageDialogs,
  watchPaseoBrowserPageDialogs,
  type PageDialogWebContents,
} from "./page-dialog-hook.js";
import {
  installPaseoBrowserPasskeyChoiceSurface,
  PASSKEY_CHOICE_SURFACE_EVENT,
  readPasskeyChoiceAnswer,
  unwatchPaseoBrowserPasskeyChoices,
  watchPaseoBrowserPasskeyChoices,
} from "./passkey-choice-surface.js";
import { getPaseoBrowserPasskeys, markPaseoBrowserUserGesture } from "./passkeys.js";
import { executeAutomationCommand } from "./service.js";
import { startScreencast, stopScreencast } from "./screencast.js";
import {
  clearPaseoBrowserAutomationActivity,
  markPaseoBrowserAutomationActivity,
} from "./activity.js";
import {
  captureFullPage as captureFullPageImage,
  type FullPageCaptureImage,
} from "./full-page-capture.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import { observeTabLoading, tabLoadingInfo } from "./load-tracker.js";
import { TabNetworkCapture } from "./network-capture.js";
import {
  addPaseoBrowserFreezeExemption,
  getPaseoBrowserTabLifecycle,
  getPaseoBrowserTargetMetadata,
  getPaseoBrowserRegistrationForWebContents,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWorkspaceId,
  getWorkspaceActivePaseoBrowserIdForHostWindow,
  listRegisteredPaseoBrowserIds,
  listRegisteredPaseoBrowserIdsForWorkspace,
  markPaseoBrowserEdited,
  reportPaseoBrowserTabs,
  getPaseoBrowserIdForWebContents,
} from "../browser-webviews/index.js";
import { BROWSER_AUTOMATION_EDITING_COMMANDS } from "../browser-webviews/discard.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
interface RecordedConsoleMessage {
  entry: BrowserAutomationConsoleLogEntry;
  /** How many main-frame navigations the tab had made when the message was logged. */
  navigation: number;
}
const consoleMessagesByContentsId = new Map<number, RecordedConsoleMessage[]>();
const mainFrameNavigationsByContentsId = new Map<number, number>();
const cdpQueuesByContentsId = new Map<number, CdpSessionQueue>();
// Delta 92: busy and crashed tab renderers are reported instead of waited on. The memory-pressure
// discard ends a renderer on purpose; that is not a crash.
const rendererHealth = new RendererHealthMonitor({
  isIntentionalCrash: (contentsId) =>
    getPaseoBrowserTabLifecycle().getState(contentsId) === "discarded",
  // Delta 93: a page waiting on its own dialog answers no script and is not busy.
  isWaitingOnDialog: (contentsId) => getPaseoBrowserPageDialogs(contentsId)?.current() != null,
});
// The full-page capture's own deadline (30 s in service.ts) plus room for it to abort.
const FULL_PAGE_CAPTURE_SLOT_TIMEOUT_MS = 35_000;
const networkCapturesByContentsId = new Map<number, TabNetworkCapture>();
const observedContentsIds = new Set<number>();
// Tabs with device emulation on; a plain resize of any other tab needs no CDP.
const emulatedContentsIds = new Set<number>();
// A phone watching a tab keeps it awake from stream_start until stream_stop or destruction.
const streamHoldReleasesByContentsId = new Map<number, () => void>();

// An agent that started network capture expects requests made while it waits; a frozen page
// makes none.
addPaseoBrowserFreezeExemption(
  (contentsId) => networkCapturesByContentsId.get(contentsId)?.capturing === true,
);
// Delta 93: a page waiting on its own dialog runs nothing to save by freezing it, its freeze
// command would wait behind the dialog, and discarding it under memory pressure would drop the
// dialog a person or agent is about to answer.
addPaseoBrowserFreezeExemption(
  (contentsId) => getPaseoBrowserPageDialogs(contentsId)?.current() != null,
);

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface HostWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
  send?(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}

export class HostSnapshotEngineRegistry {
  private readonly entries = new Map<
    number,
    { hostContents: HostWebContents; snapshotEngine: BrowserSnapshotEngine }
  >();

  public get(hostContents: HostWebContents): BrowserSnapshotEngine {
    const existing = this.entries.get(hostContents.id);
    if (existing) {
      return existing.snapshotEngine;
    }
    const snapshotEngine = new BrowserSnapshotEngine();
    const entry = { hostContents, snapshotEngine };
    this.entries.set(hostContents.id, entry);
    hostContents.once("destroyed", () => {
      if (this.entries.get(hostContents.id) === entry) {
        this.entries.delete(hostContents.id);
      }
    });
    return snapshotEngine;
  }
}

const hostSnapshotEngines = new HostSnapshotEngineRegistry();

interface WebContentsDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
  on?(event: "detach", listener: () => void): void;
  removeListener?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
}

interface ConsoleMessageEmitter {
  on(
    event: "console-message",
    listener: (
      event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown,
    ) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
  // Renderer health (delta 92).
  on(event: "unresponsive" | "responsive" | "did-start-loading", listener: () => void): unknown;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode?: number }) => void,
  ): unknown;
  // Page dialogs (delta 93).
  on(event: "will-prevent-unload", listener: (event: { preventDefault(): void }) => void): unknown;
}

interface BrowserAutomationWebContents extends ConsoleMessageEmitter {
  readonly id: number;
  readonly debugger: WebContentsDebugger;
  listenerCount(event: string): number;
  removeAllListeners(event: string): unknown;
  getURL(): string;
  getTitle(): string;
  getUserAgent?(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  isDestroyed(): boolean;
  /** Re-read at every use: a cross-origin navigation replaces the main frame. */
  readonly mainFrame: WebFrameLike;
  insertText(text: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  capturePage(rect?: Rectangle, options?: { stayHidden?: boolean }): Promise<FullPageCaptureImage>;
  invalidate(): void;
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
  addListener?(event: "did-navigate", listener: DidNavigateListener): unknown;
  addListener?(event: "did-start-loading" | "did-stop-loading", listener: () => void): unknown;
  addListener?(
    event: "did-start-navigation",
    listener: (details: { url?: string; isMainFrame?: boolean; isSameDocument?: boolean }) => void,
  ): unknown;
  removeListener?(event: "did-navigate", listener: DidNavigateListener): unknown;
  removeListener?(
    event: "did-start-navigation",
    listener: (details: NavigationStartDetails) => void,
  ): unknown;
}

interface NavigationStartDetails {
  url?: string;
  isMainFrame?: boolean;
  isSameDocument?: boolean;
}

// Electron: (event, url, httpResponseCode, httpStatusText); the code is -1 for non-HTTP documents.
type DidNavigateListener = (
  event: unknown,
  url: string,
  httpResponseCode?: number,
  httpStatusText?: string,
) => void;

/**
 * Delta 93: Daseo owns the page dialogs of every browser-profile WebContents (page-dialog-hook.ts).
 * Called as soon as one is created, and again (a no-op) from adaptWebContents.
 */
export function preparePaseoBrowserPageDialogs(contents: PageDialogWebContents): void {
  attachPaseoBrowserPageDialogs(contents);
  installPaseoBrowserPromptRestorer(contents, getCdpQueue(contents.id));
}

export function adaptWebContents(contents: BrowserAutomationWebContents): TabContents {
  const contentsId = contents.id;
  observeConsoleMessages(contents, contentsId);
  observeTabLoading({
    id: contentsId,
    isLoading: () => contents.isLoading(),
    onStartLoading: (listener) => contents.addListener?.("did-start-loading", listener),
    onStopLoading: (listener) => contents.addListener?.("did-stop-loading", listener),
    onStartMainFrameNavigation: (listener) =>
      contents.addListener?.("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument && details.url) listener(details.url);
      }),
    onDestroyed: (listener) => contents.once("destroyed", listener),
  });
  const cdpQueue = getCdpQueue(contentsId);
  const pageDialogs = attachPaseoBrowserPageDialogs(contents);
  rendererHealth.observe(contents);
  return {
    id: contentsId,
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    isLoading: () => contents.isLoading(),
    getLoadingInfo: () => tabLoadingInfo(contentsId, contents.isLoading()),
    isDestroyed: () => contents.isDestroyed(),
    // Delta 92: through the main frame. webContents.executeJavaScript waits "until web page stop
    // loading" (Electron docs), so a page with one subresource that never finishes timed out every
    // snapshot, read, and evaluate; WebFrameMain runs at once (measured with Electron 44.10.2:
    // 3 ms against no answer in 3 s).
    executeJavaScript: (code: string, userGesture?: boolean) => {
      markPaseoBrowserAutomationActivity(contentsId);
      // Delta 102: a user-gesture script is an agent's click (focus-isolated input); a passkey
      // request it starts counts as asked for, like a person's click.
      if (userGesture === true) markPaseoBrowserUserGesture(contentsId);
      return rendererHealth.runPageScript(contents, code, userGesture, "this tab");
    },
    insertText: (text: string) => {
      markPaseoBrowserAutomationActivity(contentsId);
      return contents.insertText(text);
    },
    loadURL: (url: string) => {
      markPaseoBrowserAutomationActivity(contentsId);
      return contents.loadURL(url);
    },
    goBack: () => {
      markPaseoBrowserAutomationActivity(contentsId);
      contents.goBack();
    },
    goForward: () => {
      markPaseoBrowserAutomationActivity(contentsId);
      contents.goForward();
    },
    reload: () => {
      markPaseoBrowserAutomationActivity(contentsId);
      contents.reload();
    },
    capturePage: (captureOptions) => {
      const { rect, ...electronOptions } = captureOptions ?? {};
      return contents.capturePage(rect, electronOptions);
    },
    // Upstream #4646 toggled background throttling around each capture. Here the tab lifecycle
    // owns throttling, so a capture holds the tab active instead of flipping it behind the
    // lifecycle's back.
    withFrameProduction: (capture) => getPaseoBrowserTabLifecycle().runAwake(contentsId, capture),
    captureFullPage: (options) =>
      cdpQueue.run(
        async () => {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          return captureFullPageImage(
            {
              executeJavaScript: (code) =>
                rendererHealth.runPageScript(contents, code, undefined, "this tab"),
              invalidate: () => contents.invalidate(),
              sendDebugCommand: (command, params) =>
                contents.debugger.sendCommand(command, params ?? {}),
              createImageFromPng: (dataBase64) =>
                nativeImage.createFromBuffer(Buffer.from(dataBase64, "base64")),
              createImageFromBitmap: (bitmap, size) =>
                nativeImage.createFromBitmap(Buffer.from(bitmap), {
                  ...size,
                  scaleFactor: 1,
                }),
            },
            options,
          );
          // The capture's own deadline is 30 s (service.ts); the slot outlives it briefly so the
          // capture can abort cleanly, and is released even if it never settles (delta 92).
        },
        { label: "full-page capture", timeoutMs: FULL_PAGE_CAPTURE_SLOT_TIMEOUT_MS },
      ),
    invalidate: () => contents.invalidate(),
    sendInputEvent: (event) => {
      markPaseoBrowserAutomationActivity(contentsId);
      contents.sendInputEvent(event);
    },
    getConsoleMessages: () => {
      const navigation = mainFrameNavigationsByContentsId.get(contentsId) ?? 0;
      return (consoleMessagesByContentsId.get(contentsId) ?? []).map((recorded) =>
        recorded.navigation < navigation
          ? Object.assign({}, recorded.entry, { previousPage: true })
          : recorded.entry,
      );
    },
    onMainFrameNavigated: (listener) => {
      // Electron's did-navigate fires only for main-frame cross-document commits,
      // exactly the navigations that destroy a pending evaluate's context.
      const handler: DidNavigateListener = (_event, url, httpResponseCode, httpStatusText) =>
        listener(
          url,
          typeof httpResponseCode === "number" && httpResponseCode > 0
            ? { httpStatus: httpResponseCode, httpStatusText: httpStatusText ?? "" }
            : undefined,
        );
      contents.addListener?.("did-navigate", handler);
      return () => contents.removeListener?.("did-navigate", handler);
    },
    // Daseo delta 100: what an observed click or key started outside the page's DOM.
    onMainFrameNavigationStarted: (listener) => {
      const handler = (details: NavigationStartDetails) => {
        if (details.isMainFrame && details.url)
          listener(details.url, details.isSameDocument === true);
      };
      contents.addListener?.("did-start-navigation", handler);
      return () => contents.removeListener?.("did-start-navigation", handler);
    },
    onTargetOpened: (listener) =>
      getPaseoBrowserTabEvents().subscribe((event) => {
        if (
          event.type === "tab_closed" ||
          event.type === "download_finished" ||
          event.type === "download_failed"
        ) {
          return;
        }
        if (event.browserId !== getPaseoBrowserIdForWebContents(contents)) return;
        listener({
          kind: "opened",
          type: event.type,
          ...(event.url ? { url: event.url } : {}),
          ...(event.popupBrowserId ? { browserId: event.popupBrowserId } : {}),
        });
      }),
    pageDialogs: {
      current: () => pageDialogs.current(),
      onOpening: (listener) => pageDialogs.onOpening(listener),
      refuseCommand: () => {
        markPaseoBrowserAutomationActivity(contentsId);
        return pageDialogs.refuseCommand();
      },
      dismissForNavigation: () => pageDialogs.dismissForNavigation(),
      answer: (input) => {
        markPaseoBrowserAutomationActivity(contentsId);
        return pageDialogs.answer(input);
      },
      runCommand: async (options, task) => {
        markPaseoBrowserAutomationActivity(contentsId);
        try {
          return await pageDialogs.runCommand(options, task);
        } finally {
          markPaseoBrowserAutomationActivity(contentsId);
        }
      },
    },
    sendDebugCommand: (command: string, params?: Record<string, unknown>) => {
      markPaseoBrowserAutomationActivity(contentsId);
      return cdpQueue.run(
        async () => {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          return contents.debugger.sendCommand(command, params ?? {});
        },
        { label: command },
      );
    },
    startScreencast: async (options, onFrame) => {
      if (!streamHoldReleasesByContentsId.has(contentsId)) {
        streamHoldReleasesByContentsId.set(
          contentsId,
          getPaseoBrowserTabLifecycle().hold(contentsId),
        );
      }
      await cdpQueue.run(() => startScreencast(contents, options, onFrame), {
        label: "Page.startScreencast",
      });
    },
    stopScreencast: async () => {
      try {
        await cdpQueue.run(() => stopScreencast(contents), { label: "Page.stopScreencast" });
      } finally {
        streamHoldReleasesByContentsId.get(contentsId)?.();
        streamHoldReleasesByContentsId.delete(contentsId);
      }
    },
    getNetworkCapture: () => {
      markPaseoBrowserAutomationActivity(contentsId);
      return getNetworkCapture(contents, contentsId, cdpQueue);
    },
    waitForDownload: (timeoutMs) => {
      markPaseoBrowserAutomationActivity(contentsId);
      const downloads = getPaseoBrowserAgentDownloads();
      return downloads ? downloads.waitForDownload(contentsId, timeoutMs) : Promise.resolve(null);
    },
    setDeviceEmulation: async (request) => {
      markPaseoBrowserAutomationActivity(contentsId);
      const emulation = resolveDeviceEmulation({
        ...request,
        browserUserAgent: contents.getUserAgent?.() ?? "",
      });
      if (!emulation && !emulatedContentsIds.has(contentsId)) {
        return null;
      }
      await cdpQueue.run(
        async () => {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          await applyDeviceEmulation(
            (command, params) => contents.debugger.sendCommand(command, params ?? {}),
            emulation,
            deviceEmulationHost(),
          );
        },
        { label: "device emulation" },
      );
      if (emulation) {
        emulatedContentsIds.add(contentsId);
        setPaseoBrowserClientHintOverride(
          contentsId,
          deviceEmulationClientHints(emulation, deviceEmulationHost()),
        );
      } else {
        emulatedContentsIds.delete(contentsId);
        clearPaseoBrowserClientHintOverride(contentsId);
      }
      return emulation;
    },
    // Daseo delta 110: frames for cross-origin iframe content (frames.ts).
    listFrames: () =>
      listTabFrames(() => contents.mainFrame, {
        beforeScript: (userGesture) => {
          markPaseoBrowserAutomationActivity(contentsId);
          if (userGesture) markPaseoBrowserUserGesture(contentsId);
        },
      }),
    sendFrameInput: (frameId, input) => {
      markPaseoBrowserAutomationActivity(contentsId);
      const steps = planFrameInputSteps(input);
      return cdpQueue.run(
        async () => {
          const frame = findWebFrame(contents.mainFrame, frameId);
          if (!frame) {
            throw new Error("The iframe is gone.");
          }
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          await sendFrameInputThroughTarget({
            frame,
            steps,
            send: (command, params, sessionId) =>
              contents.debugger.sendCommand(command, params ?? {}, sessionId),
          });
        },
        { label: "frame input" },
      );
    },
    collectElementStyles: (elementExpression) => {
      markPaseoBrowserAutomationActivity(contentsId);
      // One queue slot for the whole exchange, so no other command runs while CSS is enabled.
      return cdpQueue.run(
        async () => {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          return collectElementStyles({
            send: (command, params) => contents.debugger.sendCommand(command, params ?? {}),
            subscribe: (listener) => {
              const handler = (_event: unknown, method: string, params?: Record<string, unknown>) =>
                listener(method, params);
              contents.debugger.on?.("message", handler);
              return () => contents.debugger.removeListener?.("message", handler);
            },
            elementExpression,
          });
        },
        { label: "CSS styles" },
      );
    },
  };
}

function getNetworkCapture(
  contents: BrowserAutomationWebContents,
  contentsId: number,
  cdpQueue: CdpSessionQueue,
): TabNetworkCapture {
  const existing = networkCapturesByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const capture = new TabNetworkCapture({
    sendCommand: (command, params) =>
      cdpQueue.run(
        async () => {
          if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
          }
          return contents.debugger.sendCommand(command, params ?? {});
        },
        { label: command },
      ),
  });
  contents.debugger.on?.("message", (_event, method, params) =>
    capture.handleDebuggerMessage(method, params),
  );
  contents.debugger.on?.("detach", () => capture.handleDebuggerDetached());
  networkCapturesByContentsId.set(contentsId, capture);
  return capture;
}

// What the tab reports without emulation; a desktop user agent on this platform keeps its version.
function deviceEmulationHost(): DeviceEmulationHost {
  return {
    platform: userAgentDataPlatform(process.platform),
    platformVersion: process.getSystemVersion(),
  };
}

/** Delta 92: busy and crashed tab renderers (the capture harness reads it). */
export function getPaseoBrowserRendererHealth(): RendererHealthMonitor {
  return rendererHealth;
}

/** The tab's CDP command queue, shared by every feature that talks to its debugger. */
export function getPaseoBrowserCdpQueue(contentsId: number): CdpSessionQueue {
  return getCdpQueue(contentsId);
}

function getCdpQueue(contentsId: number): CdpSessionQueue {
  const existing = cdpQueuesByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const queue = new CdpSessionQueue();
  cdpQueuesByContentsId.set(contentsId, queue);
  return queue;
}

function observeConsoleMessages(contents: BrowserAutomationWebContents, contentsId: number): void {
  if (observedContentsIds.has(contentsId)) {
    return;
  }
  observedContentsIds.add(contentsId);
  contents.on("console-message", (event, level, message, line, sourceId) => {
    const eventLevel = (event as { level?: unknown } | null)?.level;
    const entry = normalizeConsoleMessage({
      level: typeof eventLevel === "string" ? eventLevel : level,
      message,
      line,
      sourceId,
    });
    const messages = consoleMessagesByContentsId.get(contentsId) ?? [];
    messages.push({ entry, navigation: mainFrameNavigationsByContentsId.get(contentsId) ?? 0 });
    consoleMessagesByContentsId.set(contentsId, messages.slice(-MAX_CONSOLE_MESSAGES_PER_TAB));
  });
  // Messages outlive navigations (a reload repeats the same errors), so each one
  // remembers which page logged it; browser_logs marks the earlier pages' messages.
  contents.addListener?.("did-navigate", () => {
    mainFrameNavigationsByContentsId.set(
      contentsId,
      (mainFrameNavigationsByContentsId.get(contentsId) ?? 0) + 1,
    );
  });
  contents.once("destroyed", () => {
    observedContentsIds.delete(contentsId);
    consoleMessagesByContentsId.delete(contentsId);
    mainFrameNavigationsByContentsId.delete(contentsId);
    emulatedContentsIds.delete(contentsId);
    clearPaseoBrowserClientHintOverride(contentsId);
    cdpQueuesByContentsId.delete(contentsId);
    networkCapturesByContentsId.delete(contentsId);
    streamHoldReleasesByContentsId.delete(contentsId);
    clearPaseoBrowserAutomationActivity(contentsId);
  });
}

// Electron's deprecated positional argument is Chromium's numeric severity;
// the event object carries the name agents recognize ("error", not "3").
const CONSOLE_LEVEL_NAMES = ["debug", "info", "warning", "error"] as const;

function consoleLevelName(level: unknown): string {
  if (typeof level === "string") {
    return level;
  }
  if (typeof level === "number" && CONSOLE_LEVEL_NAMES[level]) {
    return CONSOLE_LEVEL_NAMES[level];
  }
  return String(level ?? "log");
}

function normalizeConsoleMessage(input: {
  level: unknown;
  message: unknown;
  line: unknown;
  sourceId: unknown;
}): BrowserAutomationConsoleLogEntry {
  return {
    level: consoleLevelName(input.level),
    message: typeof input.message === "string" ? input.message : String(input.message ?? ""),
    ...(typeof input.sourceId === "string" && input.sourceId.length > 0
      ? { source: input.sourceId }
      : {}),
    ...(typeof input.line === "number" ? { line: input.line } : {}),
    timestamp: Date.now(),
  };
}

function createRegistry(hostWebContentsId: number): BrowserRegistry {
  return {
    listRegisteredBrowserIds: listRegisteredPaseoBrowserIds,
    listRegisteredBrowserIdsForWorkspace: listRegisteredPaseoBrowserIdsForWorkspace,
    getTabContents(browserId: string): TabContents | null {
      const contents = getPaseoBrowserWebContentsForHostWindow(browserId, hostWebContentsId);
      return contents ? adaptWebContents(contents) : null;
    },
    getBrowserWorkspaceId: getPaseoBrowserWorkspaceId,
    getBrowserTargetMetadata: getPaseoBrowserTargetMetadata,
    reportTabs: reportPaseoBrowserTabs,
    // The folder agent downloads go to (main.ts), so exports land beside them.
    networkExportEnvironment: () => ({
      appVersion: app.getVersion(),
      defaultDirectory: path.join(app.getPath("downloads"), "Daseo"),
    }),
    getWorkspaceActiveBrowserId(workspaceId: string): string | null {
      return getWorkspaceActivePaseoBrowserIdForHostWindow(workspaceId, hostWebContentsId);
    },
    isHostWindowFocused(): boolean {
      const host = electronWebContents.fromId(hostWebContentsId);
      if (!host || host.isDestroyed()) {
        return false;
      }
      const focused = electronWebContents.getFocusedWebContents();
      // Focus inside one of this window's browser guests still means the owner is at the Mac.
      return Boolean(focused) && (focused?.id === host.id || host.isFocused());
    },
    isBrowserInputFocused(browserId: string): boolean {
      const workspaceId = getPaseoBrowserWorkspaceId(browserId);
      if (
        !workspaceId ||
        getWorkspaceActivePaseoBrowserIdForHostWindow(workspaceId, hostWebContentsId) !== browserId
      ) {
        return false;
      }
      const target = getPaseoBrowserWebContentsForHostWindow(browserId, hostWebContentsId);
      return Boolean(target && electronWebContents.getFocusedWebContents()?.id === target.id);
    },
  };
}

export function registerBrowserAutomationIpc(options?: { ipc?: IpcHandlerRegistry }): void {
  const ipc = options?.ipc ?? ipcMain;

  // Delta 92: the renderer pings while a command is unanswered. The reply needs nothing but a
  // free main thread, so a missing reply means main is blocked, not that the page is slow.
  ipc.handle("paseo:browser:ping", () => true);

  // Delta 93: panes show a tab's held page dialog to a person and send the answer back.
  setPaseoBrowserPageDialogSurfacePorts({
    locate: getPaseoBrowserRegistrationForWebContents,
    send: (hostWebContentsId, payload) => {
      const host = electronWebContents.fromId(hostWebContentsId);
      if (host && !host.isDestroyed()) host.send(PAGE_DIALOG_SURFACE_EVENT, payload);
    },
  });
  ipc.handle("paseo:browser:watch-page-dialogs", (event) => {
    const host = (event as { sender?: HostWebContents }).sender;
    if (!host) return [];
    const hostId = host.id;
    if (!watchingHosts.has(hostId)) {
      watchingHosts.add(hostId);
      host.once("destroyed", () => {
        watchingHosts.delete(hostId);
        unwatchPaseoBrowserPageDialogs(hostId);
      });
    }
    return watchPaseoBrowserPageDialogs(hostId);
  });
  ipc.handle("paseo:browser:answer-page-dialog", (event, rawInput: unknown) => {
    const host = (event as { sender?: HostWebContents }).sender;
    const input = readPageDialogAnswer(rawInput);
    if (!host || !input) return false;
    const contents = getPaseoBrowserWebContentsForHostWindow(input.browserId, host.id);
    const dialogs = contents ? getPaseoBrowserPageDialogs(contents.id) : null;
    return (
      dialogs?.answer({
        accept: input.accept,
        ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
        by: "person",
        dialogId: input.dialogId,
      }) != null
    );
  });

  // Delta 102: panes show a person's passkey account choice and send the pick back.
  installPaseoBrowserPasskeyChoiceSurface({
    locate: getPaseoBrowserRegistrationForWebContents,
    send: (hostWebContentsId, payload) => {
      const host = electronWebContents.fromId(hostWebContentsId);
      if (host && !host.isDestroyed()) host.send(PASSKEY_CHOICE_SURFACE_EVENT, payload);
    },
  });
  ipc.handle("paseo:browser:watch-passkey-choices", (event) => {
    const host = (event as { sender?: HostWebContents }).sender;
    if (!host) return [];
    const hostId = host.id;
    if (!passkeyChoiceHosts.has(hostId)) {
      passkeyChoiceHosts.add(hostId);
      host.once("destroyed", () => {
        passkeyChoiceHosts.delete(hostId);
        unwatchPaseoBrowserPasskeyChoices(hostId);
      });
    }
    return watchPaseoBrowserPasskeyChoices(hostId);
  });
  ipc.handle("paseo:browser:answer-passkey-choice", (event, rawInput: unknown) => {
    const host = (event as { sender?: HostWebContents }).sender;
    const input = readPasskeyChoiceAnswer(rawInput);
    if (!host || !input) return false;
    const contents = getPaseoBrowserWebContentsForHostWindow(input.browserId, host.id);
    if (!contents) return false;
    return (
      getPaseoBrowserPasskeys()?.answerChoice(contents.id, input.choiceId, input.credentialId) ??
      false
    );
  });

  ipc.handle("paseo:browser:execute-automation-command", async (event, rawRequest: unknown) => {
    const hostContents = (event as { sender?: HostWebContents }).sender;
    const hostWebContentsId = hostContents?.id;
    if (!hostContents || typeof hostWebContentsId !== "number") {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: "Browser automation requires a host window.",
        },
      };
    }
    const registry = createRegistry(hostWebContentsId);
    const parsed = BrowserAutomationExecuteRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return {
        requestId: readRequestId(rawRequest),
        ok: false as const,
        error: {
          code: "browser_unsupported" as const,
          message: `Invalid automation request: ${parsed.error.message}`,
          retryable: false,
        },
      };
    }
    const execute = () =>
      Promise.resolve(
        executeAutomationCommand(parsed.data, registry, {
          snapshotEngine: hostSnapshotEngines.get(hostContents),
          streamSink: {
            sendFrame: (frame) => {
              if (hostContents.isDestroyed?.() !== true) {
                hostContents.send?.("paseo:browser:stream-frame", frame);
              }
            },
          },
        }),
      );
    // Delta 92: what happened in the agent's tabs since its last call rides on this result.
    const args = parsed.data.command.args as { browserId?: unknown } | undefined;
    const browserId = typeof args?.browserId === "string" ? args.browserId : undefined;
    const respond = async () => {
      const target = resolveCommandTargetContents(parsed.data, hostWebContentsId);
      if (target !== null && BROWSER_AUTOMATION_EDITING_COMMANDS.has(parsed.data.command.command)) {
        markPaseoBrowserEdited(target);
      }
      if (target === null) return execute();
      // Delta 92: a busy or crashed page fails here, after the wake (a frozen page runs no script).
      const checkedExecute = async () => {
        // A page waiting on its own dialog answers no script; the dialog owner answers for it.
        if (
          !RENDERER_RECOVERY_COMMANDS.has(parsed.data.command.command) &&
          getPaseoBrowserPageDialogs(target)?.current() == null
        ) {
          const health = await rendererHealth.blockingHealth(target);
          if (health) {
            return {
              requestId: parsed.data.requestId,
              ok: false as const,
              error: {
                code:
                  health.state === "crashed"
                    ? ("browser_unknown_error" as const)
                    : ("browser_timeout" as const),
                message: describeRendererHealth(browserId ?? "this tab", health),
                retryable: true,
              },
            };
          }
        }
        return execute();
      };
      // An idle tab may be throttled or frozen. Every command that touches one wakes it first and
      // holds it awake until the command answers.
      return getPaseoBrowserTabLifecycle().runAwake(target, checkedExecute);
    };
    const tabEvents = getPaseoBrowserTabEvents();
    if (browserId && parsed.data.agentId) tabEvents.linkAgent(browserId, parsed.data.agentId);
    const payload = await respond();
    const events = tabEvents.drain({
      ...(browserId ? { browserId } : {}),
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
    });
    return events.length > 0 ? { ...payload, events } : payload;
  });
}

const watchingHosts = new Set<number>();
const passkeyChoiceHosts = new Set<number>();

function readPageDialogAnswer(
  input: unknown,
): { browserId: string; dialogId: string; accept: boolean; promptText?: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (
    typeof record.browserId !== "string" ||
    typeof record.dialogId !== "string" ||
    typeof record.accept !== "boolean"
  ) {
    return null;
  }
  return {
    browserId: record.browserId,
    dialogId: record.dialogId,
    accept: record.accept,
    ...(typeof record.promptText === "string" ? { promptText: record.promptText } : {}),
  };
}

function resolveCommandTargetContents(
  request: { command: { command: string; args?: unknown } },
  hostWebContentsId: number,
): number | null {
  if (request.command.command === "stream_stop") {
    return null;
  }
  const args = request.command.args;
  const browserId =
    typeof args === "object" && args !== null && "browserId" in args
      ? (args as { browserId?: unknown }).browserId
      : undefined;
  if (typeof browserId !== "string") {
    return null;
  }
  return getPaseoBrowserWebContentsForHostWindow(browserId, hostWebContentsId)?.id ?? null;
}

function readRequestId(rawRequest: unknown): string {
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return "unknown";
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
}
