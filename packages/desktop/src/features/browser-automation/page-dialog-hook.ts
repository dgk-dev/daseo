// Daseo delta 93. Takes page dialogs over at their source, for every browser-profile WebContents.
//
// Electron 44 answers a page's alert and confirm in a JS listener on the internal per-WebContents
// event `-run-dialog` (lib/browser/api/web-contents.ts), which shows `dialog.showMessageBox`
// parented to the owner window: a sheet over the whole Daseo window, raised whether or not anyone
// automates the tab. That default listener is replaced here, so every page dialog goes to the
// tab's PageDialogController and nothing native is ever shown. `-run-dialog` is internal (the public
// event requested in electron/electron#26160 does not exist yet); when an Electron upgrade drops
// it, `webPreferences.disableDialogs` (set on every browser webview and popup in main.ts) keeps
// Electron's own listener answering without a box, and the capture harness group `dialogs` fails.
//
// Electron's renderer also replaces `window.prompt` with a function that throws ("prompt() is not
// supported", lib/renderer/window-setup.ts), so a page's prompt never reaches `-run-dialog`. A
// document-start script puts Chromium's own prompt back (taken from a short-lived about:blank
// frame and called on the page's window), so prompt goes through the same owner and an accepted
// prompt returns the agent's or person's text.

import log from "electron-log/main";
import { wasPaseoBrowserAgentDriven } from "./activity.js";
import type { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  PageDialogController,
  type HeldPageDialog,
  type PageDialogSurface,
  type PageDialogTrace,
} from "./page-dialogs.js";

export const ELECTRON_RUN_DIALOG_EVENT = "-run-dialog";
export const ELECTRON_CANCEL_DIALOGS_EVENT = "-cancel-dialogs";
/** Main to host renderer: a tab's held dialog appeared (`dialog`) or went away (`dialog: null`). */
export const PAGE_DIALOG_SURFACE_EVENT = "paseo:event:browser-page-dialog";
const PROMPT_RESTORE_SLOT_TIMEOUT_MS = 3_000;
/** How much of a dialog's message goes into main.log. */
const LOGGED_MESSAGE_CHARS = 80;

export interface ElectronRunDialogInfo {
  frame?: { url?: string } | null;
  dialogType?: string;
  messageText?: string;
  defaultPromptText?: string;
}

export type ElectronDialogCallback = (success: boolean, userInput: string) => void;

/** `-run-dialog` and `-cancel-dialogs` are internal: Electron's typings do not list them. */
interface InternalDialogEvents {
  on(
    event: typeof ELECTRON_RUN_DIALOG_EVENT,
    listener: (info: ElectronRunDialogInfo, callback: ElectronDialogCallback) => void,
  ): unknown;
  on(event: typeof ELECTRON_CANCEL_DIALOGS_EVENT, listener: () => void): unknown;
}

export interface PageDialogWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  listenerCount(event: string): number;
  removeAllListeners(event: string): unknown;
  on(event: "will-prevent-unload", listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: "did-start-loading", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
    on?(event: "detach", listener: () => void): unknown;
  };
}

/** Where a tab's or popup's dialog is shown: its browser id, its tab, and its host window. */
export interface PageDialogSurfaceLocation {
  browserId: string;
  hostWebContentsId: number;
  /** For a popup, the browser id of the tab that opened it (directly or through other popups). */
  rootBrowserId?: string;
}

/** What the surface needs from the browser registry and the host windows (set by main.ts). */
export interface PageDialogSurfacePorts {
  /** The registration of a tab or popup WebContents; null when not registered. */
  locate(contentsId: number): PageDialogSurfaceLocation | null;
  send(hostWebContentsId: number, payload: PageDialogSurfacePayload): void;
}

export interface PageDialogSurfaceDialog {
  id: string;
  type: HeldPageDialog["type"];
  message: string;
  defaultValue?: string;
  url?: string;
  openedAt: number;
  holder: HeldPageDialog["holder"];
  expiresAt?: number;
}

export interface PageDialogSurfacePayload {
  browserId: string;
  /**
   * For a popup, the tab whose pane shows its dialog. The pane shows a popup's dialog whether or
   * not that popup is the one on screen: a held dialog freezes a same-site opener too.
   */
  rootBrowserId?: string;
  dialog: PageDialogSurfaceDialog | null;
  /** With `dialog: null`: the dialog that went away. */
  dialogId?: string;
}

const controllers = new Map<number, PageDialogController>();
/**
 * Where each shown dialog went (`contentsId:dialogId`). Its hide goes to the same pane even when
 * the registration changed meanwhile or the WebContents is gone (a destroyed popup unregisters
 * before its controller closes the dialog), so no stale card stays behind.
 */
const shownDestinations = new Map<string, PageDialogSurfaceLocation>();
const hookMissingContentsIds = new Set<number>();
const watchingHostIds = new Set<number>();
let surfacePorts: PageDialogSurfacePorts | null = null;

export function setPaseoBrowserPageDialogSurfacePorts(ports: PageDialogSurfacePorts | null): void {
  surfacePorts = ports;
}

/**
 * A host renderer that can show dialogs in its panes says so once; until then dialogs on its tabs
 * are answered by policy. Returns the dialogs its tabs hold right now.
 */
export function watchPaseoBrowserPageDialogs(
  hostWebContentsId: number,
): PageDialogSurfacePayload[] {
  watchingHostIds.add(hostWebContentsId);
  const open: PageDialogSurfacePayload[] = [];
  for (const [contentsId, controller] of controllers) {
    const dialog = controller.current();
    const location = surfacePorts?.locate(contentsId);
    if (dialog && location?.hostWebContentsId === hostWebContentsId) {
      shownDestinations.set(surfaceKey(contentsId, dialog.id), location);
      open.push({ ...destinationFields(location), dialog: toSurfaceDialog(dialog) });
    }
  }
  return open;
}

export function unwatchPaseoBrowserPageDialogs(hostWebContentsId: number): void {
  watchingHostIds.delete(hostWebContentsId);
}

export function getPaseoBrowserPageDialogs(contentsId: number): PageDialogController | null {
  return controllers.get(contentsId) ?? null;
}

/** True when the tab's Electron no longer emits `-run-dialog` (the harness asserts it is false). */
export function isPaseoBrowserPageDialogHookMissing(contentsId: number): boolean {
  return hookMissingContentsIds.has(contentsId);
}

/** Installs the dialog owner on a browser-profile WebContents; later calls return the same one. */
export function attachPaseoBrowserPageDialogs(
  contents: PageDialogWebContents,
): PageDialogController {
  const contentsId = contents.id;
  const existing = controllers.get(contentsId);
  if (existing) return existing;
  const controller = new PageDialogController({
    wasAgentDriven: () => wasPaseoBrowserAgentDriven(contentsId),
    surface: surfaceFor(contentsId),
    onTrace: (trace) => logTrace(contentsId, trace),
  });
  controllers.set(contentsId, controller);

  if (contents.listenerCount(ELECTRON_RUN_DIALOG_EVENT) === 0) {
    hookMissingContentsIds.add(contentsId);
    log.error(
      "[browser-dialogs] Electron registered no -run-dialog listener; page dialogs fall back to disableDialogs",
      { contentsId },
    );
  } else {
    const internalEvents = contents as unknown as InternalDialogEvents;
    contents.removeAllListeners(ELECTRON_RUN_DIALOG_EVENT);
    internalEvents.on(ELECTRON_RUN_DIALOG_EVENT, (info, callback) => {
      let answered = false;
      const respond = (accept: boolean, text: string) => {
        if (answered) return;
        answered = true;
        try {
          callback(accept, text);
        } catch (error) {
          log.warn("[browser-dialogs] Answering a page dialog failed", { contentsId, error });
        }
      };
      try {
        controller.handleOpening(
          {
            type: info?.dialogType,
            message: info?.messageText,
            defaultValue: info?.defaultPromptText,
            url: frameUrl(info?.frame),
          },
          respond,
        );
      } catch (error) {
        log.warn("[browser-dialogs] Page dialog policy failed; answered by default", {
          contentsId,
          error,
        });
        respond(info?.dialogType === "alert", "");
      }
    });
    internalEvents.on(ELECTRON_CANCEL_DIALOGS_EVENT, () => controller.handleCancel());
  }
  // Without preventDefault Electron keeps the page and shows nothing, so a page with a
  // beforeunload handler could never be left: not by an agent's navigate, not by a person.
  contents.on("will-prevent-unload", (event) => {
    event.preventDefault();
    controller.handleBeforeUnload();
  });
  contents.once("destroyed", () => {
    controller.destroy();
    controllers.delete(contentsId);
    hookMissingContentsIds.delete(contentsId);
  });
  return controller;
}

function surfaceFor(contentsId: number): PageDialogSurface {
  return {
    available: () => {
      const location = surfacePorts?.locate(contentsId);
      return Boolean(location && watchingHostIds.has(location.hostWebContentsId));
    },
    show: (dialog) => {
      const location = surfacePorts?.locate(contentsId);
      if (location && watchingHostIds.has(location.hostWebContentsId)) {
        shownDestinations.set(surfaceKey(contentsId, dialog.id), location);
        surfacePorts?.send(location.hostWebContentsId, {
          ...destinationFields(location),
          dialog: toSurfaceDialog(dialog),
        });
      }
    },
    hide: (dialogId) => {
      const key = surfaceKey(contentsId, dialogId);
      const shownTo = shownDestinations.get(key);
      shownDestinations.delete(key);
      // Never shown: no pane holds a card for it.
      if (!shownTo) return;
      surfacePorts?.send(shownTo.hostWebContentsId, {
        ...destinationFields(shownTo),
        dialog: null,
        dialogId,
      });
    },
  };
}

function surfaceKey(contentsId: number, dialogId: string): string {
  return `${contentsId}:${dialogId}`;
}

function destinationFields(
  location: PageDialogSurfaceLocation,
): Pick<PageDialogSurfacePayload, "browserId" | "rootBrowserId"> {
  return {
    browserId: location.browserId,
    ...(location.rootBrowserId !== undefined ? { rootBrowserId: location.rootBrowserId } : {}),
  };
}

/** The dialog trail in main.log: no prompt answers, and only the start of the message. */
function logTrace(contentsId: number, trace: PageDialogTrace): void {
  const browserId = surfacePorts?.locate(contentsId)?.browserId ?? null;
  if (trace.kind === "opened") {
    log.info("[browser-dialogs] opened", {
      contentsId,
      browserId,
      type: trace.type,
      holder: trace.holder,
      host: urlHost(trace.url),
      shown: trace.shown,
      message: trace.message.slice(0, LOGGED_MESSAGE_CHARS),
    });
    return;
  }
  log.info("[browser-dialogs] answered", {
    contentsId,
    browserId,
    type: trace.type,
    by: trace.by,
    accept: trace.accept,
    heldMs: trace.heldMs,
  });
}

function urlHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function toSurfaceDialog(dialog: HeldPageDialog): PageDialogSurfaceDialog {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
    ...(dialog.url !== undefined ? { url: dialog.url } : {}),
    openedAt: dialog.openedAt,
    holder: dialog.holder,
    ...(dialog.expiresAt !== undefined ? { expiresAt: dialog.expiresAt } : {}),
  };
}

function frameUrl(frame: ElectronRunDialogInfo["frame"]): string | undefined {
  try {
    const url = frame?.url;
    return typeof url === "string" && url.length > 0 ? url : undefined;
  } catch {
    // A frame that went away throws on access.
    return undefined;
  }
}

const promptRestoredContentsIds = new Set<number>();

/**
 * Puts Chromium's own `window.prompt` back in every document of the tab (see the top of this file
 * and PROMPT_RESTORE_SCRIPT). Once per WebContents; it registers again after a DevTools session
 * ends and before each load until a registration succeeds.
 */
export function installPaseoBrowserPromptRestorer(
  contents: PageDialogWebContents,
  cdpQueue: CdpSessionQueue,
): void {
  const contentsId = contents.id;
  if (promptRestoredContentsIds.has(contentsId)) return;
  promptRestoredContentsIds.add(contentsId);
  contents.once("destroyed", () => promptRestoredContentsIds.delete(contentsId));
  // Registered once per DevTools session; runImmediately covers the documents already there.
  let state: "none" | "installing" | "installed" = "none";
  const register = async () => {
    try {
      await cdpQueue.run(
        async () => {
          if (contents.isDestroyed()) return;
          if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
          await contents.debugger.sendCommand("Page.enable");
          await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: PROMPT_RESTORE_SCRIPT,
            runImmediately: true,
          });
        },
        { label: "prompt restore", timeoutMs: PROMPT_RESTORE_SLOT_TIMEOUT_MS },
      );
      if (state === "installing") state = "installed";
    } catch (error) {
      state = "none";
      if (!contents.isDestroyed()) {
        log.warn("[browser-dialogs] prompt() not restored yet; retried at the next load", {
          contentsId,
          error,
        });
      }
    }
  };
  const install = () => {
    if (state !== "none" || contents.isDestroyed()) return;
    state = "installing";
    void register();
  };
  // A new DevTools session has no document scripts, and a WebContents that existed before it
  // could take a debugger gets its first chance here; both register before the next document.
  contents.debugger.on?.("detach", () => {
    state = "none";
  });
  contents.on("did-start-loading", install);
  install();
}

/**
 * Runs at document start in every frame of the tab, after Electron replaced `window.prompt`.
 * Chromium's own prompt comes from an about:blank frame the first time the page calls prompt, and
 * is called with the page's window as `this`, so the dialog belongs to the page's frame. The
 * function is bound, so `String(prompt)` reads like native code, as Electron's replacement did.
 * About:blank child frames are skipped: that is where the native prompt is taken from.
 */
export const PROMPT_RESTORE_SCRIPT = String.raw`(() => {
  if (window !== window.top && location.href === "about:blank") return;
  const page = window;
  const toSource = Function.prototype.toString;
  const isNativePrompt = (fn) =>
    typeof fn === "function" && fn.name === "prompt" && /\{\s*\[native code\]\s*\}$/.test(toSource.call(fn));
  let nativePrompt = isNativePrompt(page.prompt) ? page.prompt : null;
  const findNativePrompt = () => {
    if (nativePrompt) return nativePrompt;
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    parent.appendChild(frame);
    try {
      const candidate = frame.contentWindow && frame.contentWindow.prompt;
      if (isNativePrompt(candidate)) nativePrompt = candidate;
    } finally {
      frame.remove();
    }
    return nativePrompt;
  };
  function prompt(message, defaultValue) {
    const native = findNativePrompt();
    if (!native) return null;
    if (arguments.length === 0) return native.call(page);
    if (arguments.length === 1) return native.call(page, message);
    return native.call(page, message, defaultValue);
  }
  page.prompt = prompt.bind(page);
})()`;
