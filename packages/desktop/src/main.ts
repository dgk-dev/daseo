process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BaseWindow,
  BrowserWindow,
  clipboard,
  Menu,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  webContents,
  WebContentsView,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  setupDragDropPrevention,
  buildStandardContextMenuItems,
} from "./window/window-manager.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWorkspaceId,
  getPaseoBrowserTargetMetadata,
  getPaseoBrowserWebviewRegistry,
  listRegisteredPaseoBrowserIds,
  isPaseoBrowserWebviewAttach,
  PendingBrowserWindowOpenRequests,
  preparePaseoBrowserWebContents,
  registerBrowserWebviewNavigationGuards,
  registerManagedPaseoBrowserTarget,
  unregisterPaseoBrowser,
  unregisterPaseoBrowserFromHost,
  registerAttachedPaseoBrowser,
  setWorkspaceActivePaseoBrowserId,
  unregisterPaseoBrowserHost,
} from "./features/browser-webviews/index.js";
import {
  BROWSER_POPUP_TARGETS_EVENT,
  BrowserPopupTargetManager,
  type BrowserPopupContentsEvent,
  type BrowserPopupContentsPort,
  type BrowserPopupHostViewPort,
  type BrowserPopupViewPort,
} from "./features/browser-webviews/popup-targets.js";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  PASEO_BROWSER_PROFILE_PARTITION,
  getPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
} from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { PendingOpenProjectStore } from "./pending-open-project-store.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { autoUpdateInstalledSkills } from "./integrations/skills/index.js";
import {
  adaptWebContents,
  preparePersistentBrowserDialogMonitoring,
  registerBrowserAutomationIpc,
} from "./features/browser-automation/ipc.js";
import { wasPaseoBrowserRecentlyAutomated } from "./features/browser-automation/activity.js";
import { BrowserKeyboard } from "./features/browser-keyboard/index.js";
import { installAppUpdateOnQuit } from "./features/auto-updater.js";
import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@getpaseo/protocol/agent-deep-link";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "Paseo";
// Daseo fork: user-facing name only. APP_NAME stays "Paseo" because it keys the
// Electron userData path and single-instance lock; renaming it would orphan state.
const DISPLAY_APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "Daseo";
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const pendingBrowserWindowOpenRequests = new PendingBrowserWindowOpenRequests();
const agentNavigationInbox = new AgentNavigationInbox();

// A second-instance launch can arrive before the packaged protocol handler,
// IPC handlers, and first window exist. Wait for full bootstrap, not just
// app.whenReady(), before delivering navigation to the renderer.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});
let bootstrapIsComplete = false;

app.setName(APP_NAME);

interface AttachedBrowserInput {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function readAttachedBrowserInput(input: unknown): AttachedBrowserInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || record.browserId.trim().length === 0) {
    return null;
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  if (
    typeof record.webContentsId !== "number" ||
    !Number.isInteger(record.webContentsId) ||
    record.webContentsId <= 0
  ) {
    return null;
  }
  return {
    browserId: record.browserId.trim(),
    workspaceId: record.workspaceId.trim(),
    webContentsId: record.webContentsId,
  };
}

function readActiveBrowserInput(
  input: unknown,
): { workspaceId: string; browserId: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  const browserId = typeof record.browserId === "string" ? record.browserId.trim() : null;
  return { workspaceId: record.workspaceId.trim(), browserId: browserId || null };
}

const browserKeyboard = new BrowserKeyboard(getPaseoBrowserWebviewRegistry());
browserKeyboard.registerIpc();

interface ElectronBrowserPopupViewPort extends BrowserPopupViewPort {
  readonly nativeView: WebContentsView;
}

function adaptBrowserPopupContents(contents: Electron.WebContents): BrowserPopupContentsPort {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    isLoading: () => contents.isLoading(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    focus: () => contents.focus(),
    close: () => contents.close(),
    subscribe: (event: BrowserPopupContentsEvent, listener: () => void) => {
      if (event === "destroyed") contents.on("destroyed", listener);
      else if (event === "did-start-loading") contents.on("did-start-loading", listener);
      else if (event === "did-stop-loading") contents.on("did-stop-loading", listener);
      else if (event === "did-navigate") contents.on("did-navigate", listener);
      else if (event === "did-navigate-in-page") contents.on("did-navigate-in-page", listener);
      else if (event === "page-title-updated") contents.on("page-title-updated", listener);
      else contents.on("focus", listener);
    },
  };
}

function createBrowserPopupViewPort(contents: Electron.WebContents): ElectronBrowserPopupViewPort {
  const nativeView = new WebContentsView({ webContents: contents });
  return {
    nativeView,
    contents: adaptBrowserPopupContents(contents),
    setBounds: (bounds) => nativeView.setBounds(bounds),
  };
}

interface BrowserPopupParkingHost {
  window: BaseWindow;
  references: number;
}

const browserPopupParkingHosts = new WeakMap<BrowserWindow, BrowserPopupParkingHost>();

function acquireBrowserPopupParkingHost(mainWindow: BrowserWindow): BrowserPopupParkingHost {
  const existing = browserPopupParkingHosts.get(mainWindow);
  if (existing && !existing.window.isDestroyed()) {
    existing.references += 1;
    return existing;
  }
  // A WebContentsView with setVisible(false) receives a 0x0 renderer viewport. Park all
  // background targets for one app window in a shared, never-shown BaseWindow instead.
  const parkingHost = {
    window: new BaseWindow({
      show: false,
      width: 4096,
      height: 4096,
      focusable: false,
      skipTaskbar: true,
    }),
    references: 1,
  };
  browserPopupParkingHosts.set(mainWindow, parkingHost);
  return parkingHost;
}

function releaseBrowserPopupParkingHost(
  mainWindow: BrowserWindow,
  parkingHost: BrowserPopupParkingHost,
): void {
  parkingHost.references -= 1;
  if (parkingHost.references > 0) return;
  if (!parkingHost.window.isDestroyed()) parkingHost.window.destroy();
  if (browserPopupParkingHosts.get(mainWindow) === parkingHost) {
    browserPopupParkingHosts.delete(mainWindow);
  }
}

function createBrowserPopupHostViewPort(mainWindow: BrowserWindow): BrowserPopupHostViewPort {
  let parkingHost: BrowserPopupParkingHost | null = null;
  const getParkingHost = () => {
    parkingHost ??= acquireBrowserPopupParkingHost(mainWindow);
    return parkingHost;
  };
  return {
    addChildView: (view) => {
      const nativeView = (view as ElectronBrowserPopupViewPort).nativeView;
      nativeView.setVisible(true);
      getParkingHost().window.contentView.addChildView(nativeView);
    },
    setChildViewVisible: (view, visible) => {
      const nativeView = (view as ElectronBrowserPopupViewPort).nativeView;
      const parkedWindow = getParkingHost().window;
      parkedWindow.contentView.removeChildView(nativeView);
      if (!mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(nativeView);
      }
      if (visible && !mainWindow.isDestroyed()) {
        mainWindow.contentView.addChildView(nativeView);
      } else if (!parkedWindow.isDestroyed()) {
        parkedWindow.contentView.addChildView(nativeView);
      }
      nativeView.setVisible(true);
    },
    removeChildView: (view) => {
      const nativeView = (view as ElectronBrowserPopupViewPort).nativeView;
      if (!mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(nativeView);
      }
      if (parkingHost && !parkingHost.window.isDestroyed()) {
        parkingHost.window.contentView.removeChildView(nativeView);
      }
      nativeView.setVisible(false);
      if (parkingHost) {
        releaseBrowserPopupParkingHost(mainWindow, parkingHost);
        parkingHost = null;
      }
    },
  };
}

const browserPopupTargets = new BrowserPopupTargetManager({
  createBrowserId: randomUUID,
  onRegisterTarget: (target) => {
    registerManagedPaseoBrowserTarget({
      browserId: target.browserId,
      workspaceId: target.workspaceId,
      webContentsId: target.webContentsId,
      hostWebContentsId: target.hostWebContentsId,
      metadata: {
        kind: "popup",
        rootBrowserId: target.rootBrowserId,
        openerBrowserId: target.openerBrowserId,
      },
    });
    const contents = webContents.fromId(target.webContentsId);
    const hostContents = webContents.fromId(target.hostWebContentsId);
    if (contents && hostContents && !contents.isDestroyed() && !hostContents.isDestroyed()) {
      browserKeyboard.attach({ contents, hostContents });
    }
    log.info("[browser-popup] registered", target);
  },
  onUnregisterTarget: (browserId) => {
    unregisterPaseoBrowser(browserId);
    log.info("[browser-popup] unregistered", { browserId });
  },
  onSetActiveTarget: ({ browserId, workspaceId, hostWebContentsId }) => {
    setWorkspaceActivePaseoBrowserId({ browserId, workspaceId, hostWebContentsId });
  },
  onSnapshot: (snapshot) => {
    const hostContents = webContents.fromId(snapshot.hostWebContentsId);
    if (hostContents && !hostContents.isDestroyed()) {
      hostContents.send(BROWSER_POPUP_TARGETS_EVENT, snapshot);
    }
  },
});

function showBrowserWebviewContextMenu(
  win: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const menu = Menu.buildFromTemplate([
    ...buildStandardContextMenuItems(contents, params),
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          {
            label: "Inspect Element",
            click: () => {
              log.info("[browser-devtools] inspect-element.request", {
                webContentsId: contents.id,
                browserId: getPaseoBrowserIdForWebContents(contents),
                x: params.x,
                y: params.y,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
              contents.openDevTools({ mode: "detach" });
              contents.inspectElement(params.x, params.y);
              log.info("[browser-devtools] inspect-element.done", {
                webContentsId: contents.id,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
            },
          },
        ]),
  ]);
  menu.popup({ window: win });
}

function getBrowserPopupWindowOptions(
  mainWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PASEO_BROWSER_PROFILE_PARTITION,
      preload: getBrowserKeyboardPreloadPath(),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  };
}

type BrowserPopupCreateWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: Electron.WebContents;
};

function installBrowserWindowOpenHandler(input: {
  contents: Electron.WebContents;
  sourceContents: Electron.WebContents;
  mainWindow: BrowserWindow;
}): void {
  const { contents, sourceContents, mainWindow } = input;

  contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
    const decision = decideBrowserWindowOpenRequest({
      url,
      disposition,
      frameName,
      features,
      hasPostBody: postBody !== undefined && postBody !== null,
    });

    if (decision.kind === "deny") {
      return { action: "deny" };
    }
    if (decision.kind === "popup") {
      if (
        !browserPopupTargets.tryAdmit({
          rootWebContentsId: sourceContents.id,
          hostWebContentsId: mainWindow.webContents.id,
        })
      ) {
        log.warn("[browser-popup] denied by popup resource limits", {
          rootWebContentsId: sourceContents.id,
          openerWebContentsId: contents.id,
        });
        return { action: "deny" };
      }

      const previousFocusedContents = webContents.getFocusedWebContents();
      const requestActivation =
        disposition !== "background-tab" &&
        mainWindow.isFocused() &&
        contents.isFocused() &&
        !wasPaseoBrowserRecentlyAutomated(contents.id);
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: getBrowserPopupWindowOptions(mainWindow),
        createWindow: (rawOptions: Electron.BrowserWindowConstructorOptions) => {
          const options = rawOptions as BrowserPopupCreateWindowOptions;
          const popupContents = options.webContents;
          if (!popupContents || popupContents.isDestroyed()) {
            throw new Error("Electron did not provide popup WebContents for in-browser adoption");
          }
          if (popupContents.session !== getPaseoBrowserProfileSession(session)) {
            popupContents.close();
            throw new Error("Popup WebContents did not inherit the Paseo browser profile");
          }

          preparePaseoBrowserWebContents(popupContents);
          adaptWebContents(popupContents);
          preparePersistentBrowserDialogMonitoring(popupContents);
          registerBrowserWebviewNavigationGuards(popupContents);
          popupContents.on("context-menu", (_event, params) => {
            showBrowserWebviewContextMenu(mainWindow, popupContents, params);
          });
          const popupView = createBrowserPopupViewPort(popupContents);
          const popupBrowserId = browserPopupTargets.adopt({
            rootWebContentsId: sourceContents.id,
            openerWebContentsId: contents.id,
            hostWebContentsId: mainWindow.webContents.id,
            disposition,
            view: popupView,
            hostView: createBrowserPopupHostViewPort(mainWindow),
            initialBounds: { width: options.width, height: options.height },
            requestActivation,
          });
          installBrowserWindowOpenHandler({
            contents: popupContents,
            sourceContents,
            mainWindow,
          });
          log.info("[browser-popup] adopted", {
            popupBrowserId,
            rootWebContentsId: sourceContents.id,
            openerWebContentsId: contents.id,
            disposition,
            requestActivation,
          });

          setImmediate(() => {
            if (previousFocusedContents && !previousFocusedContents.isDestroyed()) {
              previousFocusedContents.focus();
            }
          });
          return popupContents;
        },
      };
    }

    const sourceBrowserId = getPaseoBrowserIdForWebContents(sourceContents);
    if (sourceBrowserId) {
      mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
        sourceBrowserId,
        url: decision.url,
      });
    } else {
      pendingBrowserWindowOpenRequests.add(sourceContents.id, decision.url);
    }
    return { action: "deny" };
  });
}

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
if (forcedUserDataDir) {
  app.setPath("userData", forcedUserDataDir);
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (!app.isPackaged) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "paseo") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (isWorktree) {
      app.setPath("userData", path.join(app.getPath("appData"), `Paseo-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// AppImage runtimes mount the app from /tmp under the user's UID, so the SUID
// chrome-sandbox helper we ship in .deb/.rpm cannot work there. Disable the
// sandbox only in that case; .deb/.rpm keep the sandbox on, matching VS Code.
if (process.platform === "linux" && process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Allow users to pass Chromium flags via PASEO_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});
let pendingAgentNavigation = parseAgentDeepLinkFromArgv(process.argv);

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
const pendingOpenProjectStore = new PendingOpenProjectStore();

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = pendingOpenProjectStore.take(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("paseo:agent-navigation:ready", (event) => {
  return agentNavigationInbox.windowReady(event.sender.id);
});

function normalizeBrowserCaptureRect(
  rect: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!rect || typeof rect !== "object") {
    return null;
  }
  const candidate = rect as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

ipcMain.handle("paseo:browser:register-attached", (event, rawInput: unknown) => {
  const input = readAttachedBrowserInput(rawInput);
  if (!input) {
    throw new Error("Invalid attached browser registration");
  }
  const registered = registerAttachedPaseoBrowser({
    ...input,
    sender: event.sender,
    profileSession: getPaseoBrowserProfileSession(session),
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) {
    throw new Error("Attached browser registration was rejected");
  }
  const guest = webContents.fromId(input.webContentsId);
  if (!guest) {
    throw new Error("Attached browser guest disappeared after registration");
  }
  browserKeyboard.attach({ contents: guest, hostContents: event.sender });
  browserPopupTargets.bindRoot({
    rootWebContentsId: guest.id,
    rootBrowserId: input.browserId,
    workspaceId: input.workspaceId,
    hostWebContentsId: event.sender.id,
  });
  log.info("[browser-webview] registered", {
    browserId: input.browserId,
    webContentsId: input.webContentsId,
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  for (const url of pendingBrowserWindowOpenRequests.take(input.webContentsId)) {
    event.sender.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
      sourceBrowserId: input.browserId,
      url,
    });
  }
});

ipcMain.handle("paseo:browser:unregister-workspace-browser", async (event, browserId: unknown) => {
  if (typeof browserId === "string" && browserId.trim().length > 0) {
    const normalizedBrowserId = browserId.trim();
    const hasOtherHost = getPaseoBrowserWebviewRegistry().hasBrowserInOtherHostWindow(
      event.sender.id,
      normalizedBrowserId,
    );
    browserPopupTargets.closeRoot({
      rootBrowserId: normalizedBrowserId,
      hostWebContentsId: event.sender.id,
    });
    unregisterPaseoBrowserFromHost(event.sender.id, normalizedBrowserId);
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    const legacyProfile = hasOtherHost
      ? null
      : getLegacyPaseoBrowserProfileSession(session, normalizedBrowserId);
    if (legacyProfile) {
      try {
        await clearPaseoBrowserProfile({
          profileSessions: [legacyProfile],
          listGuests: () => [],
          logReloadError: () => {},
        });
      } catch (error) {
        log.warn("[browser-profile] failed to clear legacy tab profile", {
          browserId: normalizedBrowserId,
          error,
        });
      }
    }
  }
});

ipcMain.handle("paseo:browser:set-workspace-active-browser", (event, rawInput: unknown) => {
  const input = readActiveBrowserInput(rawInput);
  if (input) {
    setWorkspaceActivePaseoBrowserId({ ...input, hostWebContentsId: event.sender.id });
  }
});

ipcMain.handle("paseo:browser:list-popup-targets", (event, rootBrowserId: unknown) => {
  if (typeof rootBrowserId !== "string" || rootBrowserId.trim().length === 0) {
    return null;
  }
  return browserPopupTargets.getSnapshot({
    rootBrowserId: rootBrowserId.trim(),
    hostWebContentsId: event.sender.id,
  });
});

ipcMain.handle("paseo:browser:present-popup-target", (event, rawInput: unknown): boolean => {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return false;
  }
  const input = rawInput as Record<string, unknown>;
  const rootBrowserId = typeof input.rootBrowserId === "string" ? input.rootBrowserId.trim() : "";
  const popupBrowserId =
    typeof input.popupBrowserId === "string" ? input.popupBrowserId.trim() : null;
  const visible = input.visible === true;
  if (!rootBrowserId || (visible && !popupBrowserId)) {
    return false;
  }
  const rawBounds = visible ? normalizeBrowserCaptureRect(input.bounds) : null;
  if (visible && !rawBounds) {
    return false;
  }
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  const bounds = rawBounds
    ? {
        x: Math.min(rawBounds.x, Math.max(0, contentWidth - 1)),
        y: Math.min(rawBounds.y, Math.max(0, contentHeight - 1)),
        width: Math.max(1, Math.min(rawBounds.width, contentWidth - rawBounds.x)),
        height: Math.max(1, Math.min(rawBounds.height, contentHeight - rawBounds.y)),
      }
    : undefined;
  return browserPopupTargets.setPresentation({
    rootBrowserId,
    hostWebContentsId: event.sender.id,
    popupBrowserId,
    visible,
    ...(bounds ? { bounds } : {}),
    focus: input.focus === true,
  });
});

ipcMain.handle("paseo:browser:close-popup-target", (event, rawInput: unknown): boolean => {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return false;
  }
  const input = rawInput as Record<string, unknown>;
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  if (!browserId || !workspaceId || getPaseoBrowserWorkspaceId(browserId) !== workspaceId) {
    return false;
  }
  return browserPopupTargets.closeTarget({
    browserId,
    hostWebContentsId: event.sender.id,
  });
});

ipcMain.handle("paseo:browser:resize-popup-target", (event, rawInput: unknown) => {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return null;
  }
  const input = rawInput as Record<string, unknown>;
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  const width = input.width;
  const height = input.height;
  if (
    !browserId ||
    !workspaceId ||
    getPaseoBrowserWorkspaceId(browserId) !== workspaceId ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null;
  }
  return browserPopupTargets.resizeTarget({
    browserId,
    hostWebContentsId: event.sender.id,
    width,
    height,
  });
});

ipcMain.handle("paseo:browser:popup-target-action", async (event, rawInput: unknown) => {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return false;
  }
  const input = rawInput as Record<string, unknown>;
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const action = typeof input.action === "string" ? input.action : "";
  if (!browserId || getPaseoBrowserTargetMetadata(browserId).kind !== "popup") {
    return false;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    return false;
  }
  if (action === "back") {
    if (contents.canGoBack()) contents.goBack();
    return true;
  }
  if (action === "forward") {
    if (contents.canGoForward()) contents.goForward();
    return true;
  }
  if (action === "reload") {
    contents.reload();
    return true;
  }
  if (action === "stop") {
    contents.stop();
    return true;
  }
  if (action === "navigate" && typeof input.url === "string") {
    const url = input.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
    } catch {
      return false;
    }
    await contents.loadURL(url);
    return true;
  }
  return false;
});

ipcMain.handle("paseo:browser:focus", (event, browserId: unknown): boolean => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return false;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    return false;
  }
  contents.focus();
  return true;
});

ipcMain.handle("paseo:browser:open-devtools", (event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    const result = {
      ok: false,
      reason: "invalid-browser-id",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.invalid", result);
    return result;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.not-found", result);
    return result;
  }
  log.info("[browser-devtools] open-devtools.request", {
    browserId,
    webContentsId: contents.id,
    isDestroyed: contents.isDestroyed(),
    isDevToolsOpened: contents.isDevToolsOpened(),
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  contents.openDevTools({ mode: "detach" });
  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: contents.id,
    isDevToolsOpened: contents.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:clear-profile", async (_event, rawLegacyBrowserIds: unknown) => {
  const profileSessions = getPaseoBrowserProfileSessions(
    session,
    readLegacyPaseoBrowserIds(rawLegacyBrowserIds),
  );
  const profileSession = profileSessions[0];
  await clearPaseoBrowserProfile({
    profileSessions,
    listGuests: () =>
      listPaseoBrowserProfileGuests({
        profileSession,
        webContents: webContents.getAllWebContents(),
      }),
    logReloadError: (webContentsId, error) => {
      log.warn("[browser-profile] failed to reload guest", { webContentsId, error });
    },
  });
});

ipcMain.handle(
  "paseo:browser:capture-element",
  async (event, browserId: unknown, rect: unknown) => {
    if (typeof browserId !== "string" || browserId.trim().length === 0) {
      return null;
    }
    const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
    if (!contents || contents.isDestroyed()) {
      return null;
    }
    const captureRect = normalizeBrowserCaptureRect(rect);
    if (!captureRect) {
      return null;
    }
    try {
      // capturePage expects an integer rect in CSS pixels relative to the
      // guest viewport, which matches getBoundingClientRect() on the page.
      const image = await contents.capturePage(captureRect);
      if (image.isEmpty()) {
        return null;
      }
      return image.toDataURL();
    } catch (error) {
      log.warn("[browser-capture] capture-element.failed", {
        browserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
);

ipcMain.handle("paseo:browser:copy-element", (_event, payload: unknown): boolean => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const { text, imageDataUrl } = payload as { text?: unknown; imageDataUrl?: unknown };
  const copyText = typeof text === "string" && text.length > 0 ? text : null;

  // Resolve the image first so we can write the clipboard exactly once and
  // avoid flashing an intermediate text-only state.
  let image: Electron.NativeImage | null = null;
  if (typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image")) {
    try {
      const candidate = nativeImage.createFromDataURL(imageDataUrl);
      if (!candidate.isEmpty()) {
        image = candidate;
      }
    } catch (error) {
      log.warn("[browser-capture] copy-element.image-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Writing from the main process avoids the renderer's navigator.clipboard
  // NotAllowedError, which fires when focus is inside the guest <webview>.
  if (copyText && image) {
    clipboard.write({ text: copyText, image });
    return true;
  }
  if (image) {
    clipboard.writeImage(image);
    return true;
  }
  if (copyText) {
    clipboard.writeText(copyText);
    return true;
  }
  return false;
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getBrowserKeyboardPreloadPath(): string {
  return path.join(__dirname, "features", "browser-keyboard", "guest-preload.js");
}

function getAppDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }

  return path.resolve(__dirname, "../../app/dist");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [path.resolve(__dirname, "../assets/icon.png")];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function applyAppIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const iconPath = getWindowIconPath();
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

async function createWindow(
  options: {
    initialRoute?: string | null;
    pendingOpenProjectPath?: string | null;
    restoreWindowState?: boolean;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;

  const title = devWorktreeName ? `${DISPLAY_APP_NAME} (${devWorktreeName})` : DISPLAY_APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      platform: process.platform,
      theme: systemTheme,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const webContentsId = mainWindow.webContents.id;
  pendingOpenProjectStore.set(webContentsId, options.pendingOpenProjectPath);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      agentNavigationInbox.windowLoading(webContentsId);
    }
  });
  mainWindow.on("closed", () => {
    pendingOpenProjectStore.delete(webContentsId);
    agentNavigationInbox.removeWindow(webContentsId);
    browserPopupTargets.closeHost(webContentsId);
    unregisterPaseoBrowserHost(webContentsId);
    browserKeyboard.detachHost(webContentsId);
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isPaseoBrowserWebviewAttach(params)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    // The sandboxed keyboard preload must run in every frame so focused iframes keep
    // the same page-first shortcut boundary. Node integration remains disabled.
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.webviewTag = false;
    webPreferences.allowRunningInsecureContent = false;
    delete webPreferences.preload;
    delete params.preload;
    delete (webPreferences as { preloadURL?: string }).preloadURL;
    delete (params as { preloadURL?: string }).preloadURL;
    webPreferences.preload = getBrowserKeyboardPreloadPath();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    preparePaseoBrowserWebContents(contents);
    adaptWebContents(contents);
    contents.once("destroyed", () => {
      pendingBrowserWindowOpenRequests.delete(contents.id);
      browserPopupTargets.closeRootByWebContents(contents.id);
    });
    installBrowserWindowOpenHandler({
      contents,
      sourceContents: contents,
      mainWindow,
    });
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    registerBrowserWebviewNavigationGuards(contents);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    const initialUrl = options.initialRoute
      ? new URL(options.initialRoute, `${DEV_SERVER_URL}/`).toString()
      : DEV_SERVER_URL;
    await mainWindow.loadURL(initialUrl);
    return mainWindow;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app${options.initialRoute ?? "/"}`);
  return mainWindow;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

let agentNavigationWindowCreation: Promise<BrowserWindow> | null = null;

function focusExistingWindowOnAgent(target: AgentDeepLinkTarget): void {
  const windows = BrowserWindow.getAllWindows();
  const mainWindow =
    BrowserWindow.getFocusedWindow() ?? windows.find((window) => window.isVisible()) ?? windows[0];
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!agentNavigationWindowCreation) {
      const creation = createWindow({
        initialRoute: buildAgentDeepLinkRoute(target),
        restoreWindowState: true,
      });
      agentNavigationWindowCreation = creation;
      void creation
        .catch((error) => log.error("[window] failed to create window for agent link", error))
        .finally(() => {
          if (agentNavigationWindowCreation === creation) {
            agentNavigationWindowCreation = null;
          }
        });
      return;
    }

    void agentNavigationWindowCreation
      .then(() => focusExistingWindowOnAgent(target))
      .catch((error) => log.error("[window] failed to deliver queued agent link", error));
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();

  const deliverable = agentNavigationInbox.deliverOrQueue(mainWindow.webContents.id, target);
  if (deliverable) {
    mainWindow.webContents.send("paseo:event:open-agent", deliverable);
  }
}

function receiveAgentDeepLink(input: string): void {
  const target = parseAgentDeepLink(input);
  if (!target) {
    return;
  }

  if (bootstrapIsComplete) {
    focusExistingWindowOnAgent(target);
    return;
  }

  pendingAgentNavigation = target;
  void bootstrapComplete.then(() => {
    if (pendingAgentNavigation !== target) {
      return undefined;
    }
    pendingAgentNavigation = null;
    focusExistingWindowOnAgent(target);
    return undefined;
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAgentDeepLink(url);
});

function setupSingleInstanceLock(): boolean {
  if (DISABLE_SINGLE_INSTANCE_LOCK) {
    log.info("[single-instance] disabled by PASEO_DISABLE_SINGLE_INSTANCE_LOCK");
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", (_event, commandLine) => {
    const agentTarget = parseAgentDeepLinkFromArgv(commandLine);
    if (agentTarget) {
      void bootstrapComplete.then(() => focusExistingWindowOnAgent(agentTarget));
      return;
    }

    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // Relaunching the app (CLI `paseo [path]`, double-click, etc.) opens a new
    // window rather than focusing the existing one. Wait for bootstrap (not just
    // app.whenReady) so the protocol + IPC handlers exist before the window loads.
    void bootstrapComplete
      .then(() => createWindow({ pendingOpenProjectPath: openProjectPath }))
      .catch((error) => {
        log.error("[window] failed to create window from second-instance", error);
      });
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();

  const appDistDir = getAppDistDir();
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname, search, hash } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);

    // Chromium can occasionally request the exported entrypoint directly.
    // Canonicalize it back to the route URL so Expo Router sees `/`, not `/index.html`.
    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback: serve index.html for routes without a file extension
    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  applyAppIcon();
  setupApplicationMenu({
    onNewWindow: () => {
      void createWindow().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  registerEditorTargetHandlers();
  registerBrowserAutomationIpc();

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await createWindow({
      pendingOpenProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The first window of the session restores and persists saved geometry.
  const initialAgentNavigation = pendingAgentNavigation;
  pendingAgentNavigation = null;
  await createWindow({
    initialRoute: initialAgentNavigation ? buildAgentDeepLinkRoute(initialAgentNavigation) : null,
    pendingOpenProjectPath,
    restoreWindowState: true,
  });
  pendingOpenProjectPath = null;

  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  bootstrapIsComplete = true;
  resolveBootstrapComplete();

  if (pendingAgentNavigation) {
    const target = pendingAgentNavigation;
    pendingAgentNavigation = null;
    focusExistingWindowOnAgent(target);
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow({ restoreWindowState: true });
    }
  });
}

void runDesktopStartup({
  hasPendingGuiLaunchRequest: Boolean(pendingOpenProjectPath || pendingAgentNavigation),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
  autoUpdateInstalledSkills: () => {
    void autoUpdateInstalledSkills().catch((error) => {
      log.error("[skills] auto-update failed", error);
    });
  },
}).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:quitting", {});
  }
}

const quitLifecycle = createQuitLifecycle({
  app,
  closeTransportSessions: closeAllTransportSessions,
  stopDesktopManagedDaemonIfNeeded: () =>
    stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: getDesktopSettingsStore(),
      isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
      stopDaemon: () => stopDesktopDaemonViaCli("quit"),
      showShutdownFeedback: showDaemonShutdownDialog,
    }),
  installAppUpdateOnQuit: async (signal) => {
    const settings = await getDesktopSettingsStore().get();
    return installAppUpdateOnQuit({
      currentVersion: app.getVersion(),
      releaseChannel: settings.releaseChannel,
      signal,
    });
  },
  createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
  onStopError: (error) => {
    log.error("[desktop daemon] failed to stop managed daemon on quit", error);
  },
  onUpdateError: (error) => {
    log.error("[auto-updater] failed to validate downloaded update on quit", error);
  },
});

// electron-updater forwards this event through Electron's built-in autoUpdater.
electronAutoUpdater.on("before-quit-for-update", quitLifecycle.handleBeforeQuitForUpdate);
app.on("before-quit", quitLifecycle.handleBeforeQuit);
registerExternalQuitSignals({ signals: process, quit: () => app.quit() });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
