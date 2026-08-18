import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import {
  ensureResidentBrowserWebview as ensureResidentBrowserWebviewDefault,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import {
  adoptWorkspaceBrowser,
  createFixedBrowserViewport,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/desktop/browser/store";
import {
  collectAllTabs,
  getFocusedBrowserId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];
type BrowserAutomationFailurePayload = Extract<BrowserAutomationResponsePayload, { ok: false }>;
type BrowserAutomationSuccessPayload = Extract<BrowserAutomationResponsePayload, { ok: true }>;
type BrowserAutomationListTabsResult = Extract<
  BrowserAutomationSuccessPayload["result"],
  { command: "list_tabs" }
>;
type BrowserAutomationTabInfo = BrowserAutomationListTabsResult["tabs"][number];
type BrowserAutomationErrorCode = BrowserAutomationFailurePayload["error"]["code"];

interface BrowserAutomationClient {
  on(
    type: "browser.automation.execute.request",
    handler: (message: BrowserAutomationExecuteRequest) => void,
  ): () => void;
  sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void;
  sendBrowserStreamFrame?(input: {
    browserId: string;
    seq: number;
    width: number;
    height: number;
    dataBase64: string;
  }): void;
}

function isBrowserStreamFramePayload(payload: unknown): payload is {
  browserId: string;
  seq: number;
  width: number;
  height: number;
  dataBase64: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const frame = payload as Record<string, unknown>;
  return (
    typeof frame.browserId === "string" &&
    typeof frame.seq === "number" &&
    typeof frame.width === "number" &&
    typeof frame.height === "number" &&
    typeof frame.dataBase64 === "string"
  );
}

export interface BrowserAutomationHandlerOptions {
  client: BrowserAutomationClient;
  serverId?: string;
  getHost?: () => DesktopHostBridge | null;
  ensureResidentBrowserWebview?: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}

export function mountBrowserAutomationHandler(
  options: BrowserAutomationHandlerOptions,
): () => void {
  const getHost = options.getHost ?? getDesktopHost;
  const sendStreamFrame = options.client.sendBrowserStreamFrame?.bind(options.client);
  const unsubscribeStreamFrames =
    sendStreamFrame && getHost()?.browser?.onStreamFrame
      ? getHost()?.browser?.onStreamFrame?.((payload) => {
          if (isBrowserStreamFramePayload(payload)) {
            sendStreamFrame(payload);
          }
        })
      : undefined;
  const unsubscribe = options.client.on("browser.automation.execute.request", (request) => {
    void handleBrowserAutomationRequest({
      client: options.client,
      getHost,
      request,
      serverId: options.serverId,
      ensureResidentBrowserWebview:
        options.ensureResidentBrowserWebview ?? ensureResidentBrowserWebviewDefault,
      ...(options.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: options.registrationWaitTimeoutMs }
        : {}),
      ...(options.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: options.registrationPollIntervalMs }
        : {}),
    });
  });
  return () => {
    unsubscribeStreamFrames?.();
    unsubscribe();
  };
}

export function mountBrowserAutomationDaemonClientHandler(
  client: unknown,
  options?: { serverId?: string },
): () => void {
  return mountBrowserAutomationHandler({
    client: client as BrowserAutomationClient,
    ...(options?.serverId ? { serverId: options.serverId } : {}),
  });
}

async function handleBrowserAutomationRequest(params: {
  client: BrowserAutomationHandlerOptions["client"];
  getHost: () => DesktopHostBridge | null;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<void> {
  const {
    client,
    getHost,
    request,
    serverId,
    ensureResidentBrowserWebview,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const browserHost = getHost()?.browser;
  const executeAutomationCommand = browserHost?.executeAutomationCommand;

  if (request.command.command === "list_tabs" && serverId && request.workspaceId) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: await listWorkspaceBrowserTabsForRequest({
        request,
        serverId,
        browserHost,
        ensureResidentBrowserWebview,
      }),
    });
    return;
  }

  if (request.command.command === "new_tab") {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await openBrowserTabForRequest({
          request,
          serverId,
          browserHost,
          ensureResidentBrowserWebview,
          ...(registrationWaitTimeoutMs !== undefined ? { registrationWaitTimeoutMs } : {}),
          ...(registrationPollIntervalMs !== undefined ? { registrationPollIntervalMs } : {}),
        }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (request.command.command === "resize") {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: await resizeBrowserTabForRequest({ request, serverId, browserHost }),
    });
    return;
  }

  if (request.command.command === "close_tab") {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await closeBrowserTabForRequest({
          request,
          serverId,
          browserHost,
        }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (!executeAutomationCommand) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Browser automation is not available in this app runtime.",
      }),
    });
    return;
  }

  try {
    const payload = await executeAutomationCommand(request);
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeBridgePayload(request.requestId, payload),
    });
  } catch (error) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeThrownBridgeError(request.requestId, error),
    });
  }
}

async function listWorkspaceBrowserTabsForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, serverId, browserHost, ensureResidentBrowserWebview } = params;
  const workspaceId = request.workspaceId;
  if (!workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot list browser tabs without a workspace context.",
    });
  }
  if (!useWorkspaceLayoutStore.persist.hasHydrated() || !useBrowserStore.persist.hasHydrated()) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_timeout",
      message: "Browser tab state is still restoring on the desktop host.",
      retryable: true,
    });
  }

  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = workspaceKey
    ? useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]
    : null;
  if (!layout) {
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    };
  }

  const layoutActiveBrowserId = getFocusedBrowserId(layout);
  const seen = new Set<string>();
  const layoutTabs = collectAllTabs(layout.root).flatMap((tab) => {
    if (tab.target.kind !== "browser" || seen.has(tab.target.browserId)) return [];
    const { browserId } = tab.target;
    seen.add(browserId);
    let browser = getBrowserRecord(browserId);
    if (!browser) {
      adoptWorkspaceBrowser(browserId);
      browser = getBrowserRecord(browserId);
    }
    if (!browser) return [];

    if (browserHost?.executeAutomationCommand) {
      try {
        ensureResidentBrowserWebview({ browserId, workspaceId, url: browser.url });
      } catch {
        // The layout remains authoritative even while a guest is reattaching.
      }
    }
    return [
      {
        browserId,
        workspaceId,
        url: browser.url,
        title: browser.title,
        isActive: browserId === layoutActiveBrowserId,
        isLoading: browser.isLoading,
        canGoBack: browser.canGoBack,
        canGoForward: browser.canGoForward,
      },
    ];
  });

  let liveTabs: BrowserAutomationTabInfo[] = [];
  if (browserHost?.executeAutomationCommand) {
    try {
      const livePayload = await browserHost.executeAutomationCommand(request);
      if (livePayload.ok && livePayload.result.command === "list_tabs") {
        liveTabs = livePayload.result.tabs.filter(
          (tab) => !tab.workspaceId || tab.workspaceId === workspaceId,
        );
      }
    } catch {
      // Persisted layout tabs remain usable while the Electron target registry reattaches.
    }
  }

  const liveByBrowserId = new Map(liveTabs.map((tab) => [tab.browserId, tab]));
  const liveHasActiveTarget = liveTabs.some((tab) => tab.isActive);
  const tabs: BrowserAutomationTabInfo[] = [];
  for (const layoutTab of layoutTabs) {
    const liveRoot = liveByBrowserId.get(layoutTab.browserId);
    tabs.push(
      liveRoot
        ? {
            ...layoutTab,
            ...liveRoot,
            workspaceId,
            isActive: liveRoot.isActive,
          }
        : {
            ...layoutTab,
            isActive: liveHasActiveTarget ? false : layoutTab.isActive,
          },
    );
    for (const candidate of liveTabs) {
      if (candidate.kind === "popup" && candidate.rootBrowserId === layoutTab.browserId) {
        tabs.push(candidate);
      }
    }
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "list_tabs", tabs },
  };
}

async function resizeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, serverId, browserHost } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "resize" }
  >;
  const browserId = command.args.browserId;
  const workspaceId = request.workspaceId;
  const browser = getBrowserRecord(browserId);
  if (browser) {
    if (serverId && workspaceId && !findWorkspaceBrowserTab({ serverId, workspaceId, browserId })) {
      return browserTabNotFound(request.requestId, browserId);
    }
    const dimensions = resizeResidentBrowserWebview({
      browserId,
      width: command.args.width,
      height: command.args.height,
    });
    if (!dimensions) {
      return browserTabNotFound(request.requestId, browserId);
    }
    useBrowserStore
      .getState()
      .setBrowserViewport(
        browserId,
        createFixedBrowserViewport(dimensions.width, dimensions.height),
      );
    const settledDimensions = await settleResidentBrowserResize({
      browserId,
      width: dimensions.width,
      height: dimensions.height,
    });
    return browserResizeSuccess(request.requestId, browserId, settledDimensions ?? dimensions);
  }

  if (workspaceId && browserHost?.resizePopupTarget) {
    const dimensions = await browserHost.resizePopupTarget({
      browserId,
      workspaceId,
      width: command.args.width,
      height: command.args.height,
    });
    if (dimensions) {
      return browserResizeSuccess(request.requestId, browserId, dimensions);
    }
  }
  return browserTabNotFound(request.requestId, browserId);
}

async function settleResidentBrowserResize(input: {
  browserId: string;
  width: number;
  height: number;
}): Promise<{ width: number; height: number } | null> {
  let dimensions: { width: number; height: number } | null = null;
  for (let frame = 0; frame < 2; frame += 1) {
    await waitForBrowserPresentationFrame();
    dimensions = resizeResidentBrowserWebview(input);
  }
  return dimensions;
}

async function waitForBrowserPresentationFrame(): Promise<void> {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => globalThis.requestAnimationFrame(() => resolve())),
    delay(50),
  ]);
}

function browserResizeSuccess(
  requestId: string,
  browserId: string,
  dimensions: { width: number; height: number },
): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "resize",
      browserId,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

function browserTabNotFound(requestId: string, browserId: string): BrowserAutomationFailurePayload {
  return browserAutomationFailure({
    requestId,
    code: "browser_tab_not_found",
    message: `No browser tab found for ID: ${browserId}`,
  });
}

async function closeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, serverId, browserHost } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "close_tab" }
  >;
  const browserId = command.args.browserId;
  const workspaceId = request.workspaceId;
  const workspaceTab = serverId
    ? findWorkspaceBrowserTab({ serverId, workspaceId, browserId })
    : null;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot close a browser tab without a workspace context.",
    });
  }
  if (workspaceTab && getBrowserRecord(browserId)) {
    useWorkspaceLayoutStore.getState().closeTab(workspaceTab.workspaceKey, workspaceTab.tabId);
    useBrowserStore.getState().removeBrowser(browserId);
    removeResidentBrowserWebview(browserId);
    await browserHost?.unregisterWorkspaceBrowser?.(browserId);
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "close_tab", browserId },
    };
  }

  const closedPopup = await browserHost?.closePopupTarget?.({ browserId, workspaceId });
  if (closedPopup) {
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "close_tab", browserId },
    };
  }
  return browserAutomationFailure({
    requestId: request.requestId,
    code: "browser_tab_not_found",
    message: `No browser tab found for ID: ${browserId}`,
  });
}

function findWorkspaceBrowserTab(input: {
  serverId: string;
  workspaceId: string | undefined;
  browserId: string;
}): { workspaceKey: string; tabId: string } | null {
  if (!input.workspaceId) {
    return null;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) {
    return null;
  }
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const tab = layout
    ? collectAllTabs(layout.root).find((candidate) => {
        return (
          candidate.target.kind === "browser" && candidate.target.browserId === input.browserId
        );
      })
    : null;
  return tab ? { workspaceKey, tabId: tab.tabId } : null;
}

async function openBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<BrowserAutomationResponsePayload> {
  const {
    request,
    serverId,
    browserHost,
    ensureResidentBrowserWebview,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "new_tab" }
  >;
  const workspaceId = request.workspaceId;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }

  const url = command.args.url ?? "https://example.com";
  const { browserId, url: normalizedUrl } = createWorkspaceBrowser({ initialUrl: url });
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }
  useWorkspaceLayoutStore.getState().openTabInBackground(workspaceKey, {
    kind: "browser",
    browserId,
  });

  if (browserHost?.executeAutomationCommand) {
    ensureResidentBrowserWebview({ browserId, workspaceId, url: normalizedUrl });
    const registered = await waitForBrowserRegistration({
      request,
      browserId,
      workspaceId,
      executeAutomationCommand: browserHost.executeAutomationCommand,
      ...(registrationWaitTimeoutMs !== undefined ? { timeoutMs: registrationWaitTimeoutMs } : {}),
      ...(registrationPollIntervalMs !== undefined
        ? { pollIntervalMs: registrationPollIntervalMs }
        : {}),
    });
    if (!registered) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_timeout",
        message: `Timed out waiting for browser tab ${browserId} to register with the browser automation host. Try browser_new_tab again.`,
        retryable: true,
      });
    }
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "new_tab", browserId, workspaceId, url: normalizedUrl },
  };
}

async function waitForBrowserRegistration(params: {
  request: BrowserAutomationExecuteRequest;
  browserId: string;
  workspaceId: string;
  executeAutomationCommand: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationResponsePayload>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const payload = await params.executeAutomationCommand({
      type: "browser.automation.execute.request",
      requestId: `${params.request.requestId}:list_tabs`,
      agentId: params.request.agentId,
      cwd: params.request.cwd,
      workspaceId: params.workspaceId,
      command: { command: "list_tabs", args: {} },
    });
    if (payload.ok && payload.result.command === "list_tabs") {
      if (payload.result.tabs.some((tab) => tab.browserId === params.browserId)) {
        return true;
      }
    }
    await delay(params.pollIntervalMs ?? 100);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBridgePayload(
  requestId: string,
  payload: BrowserAutomationResponsePayload,
): BrowserAutomationResponsePayload {
  return { ...payload, requestId } as BrowserAutomationResponsePayload;
}

function normalizeThrownBridgeError(
  requestId: string,
  error: unknown,
): BrowserAutomationFailurePayload {
  const typed = readTypedBrowserAutomationError(error);
  if (typed) {
    return browserAutomationFailure({ requestId, ...typed });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) {
    return browserAutomationFailure({
      requestId,
      code: "browser_unsupported",
      message: "Browser automation is not implemented by this app build yet.",
    });
  }

  return browserAutomationFailure({
    requestId,
    code: "browser_unknown_error",
    message: message || "Browser automation failed.",
  });
}

function readTypedBrowserAutomationError(
  value: unknown,
): { code: BrowserAutomationErrorCode; message: string; retryable?: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !record.code.startsWith("browser_")) {
    return null;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return null;
  }
  return {
    code: record.code as BrowserAutomationErrorCode,
    message: record.message,
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}

function browserAutomationFailure(params: {
  requestId: string;
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserAutomationFailurePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
}
