export interface ScreencastFramePayload {
  seq: number;
  dataBase64: string;
  /** CSS viewport size reported by the screencast frame metadata. */
  width: number;
  height: number;
}

export interface ScreencastOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  minFrameIntervalMs?: number;
  /** Host-measured CSS viewport used when Chromium omits frame dimensions. */
  viewportWidth?: number;
  viewportHeight?: number;
}

interface ScreencastDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
}

export interface ScreencastContents {
  readonly id: number;
  readonly debugger: ScreencastDebugger;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): void;
}

interface PendingScreencastFrame {
  sessionId?: number;
  dataBase64: string;
  width: number;
  height: number;
}

interface ActiveScreencast {
  onFrame: (frame: ScreencastFramePayload) => void;
  quality: number;
  minFrameIntervalMs: number;
  viewportWidth: number;
  viewportHeight: number;
  lastFrameSentAt: number;
  pendingFrame: PendingScreencastFrame | null;
  pendingFrameTimer: ReturnType<typeof setTimeout> | null;
  navigationCaptureTimer: ReturnType<typeof setTimeout> | null;
  captureGeneration: number;
}

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 1280;
const DEFAULT_QUALITY = 60;
const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000;
const NAVIGATION_CAPTURE_DELAY_MS = 250;

const activeByContentsId = new Map<number, ActiveScreencast>();
const nextSequenceByContentsId = new Map<number, number>();
const listeningContentsIds = new Set<number>();

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

async function sendCommandWithTimeout(
  contents: ScreencastContents,
  command: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const commandPromise =
      params === undefined
        ? contents.debugger.sendCommand(command)
        : contents.debugger.sendCommand(command, params);
    return await Promise.race([
      commandPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out while running ${command}`));
        }, DEBUGGER_COMMAND_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function acknowledgeFrame(contents: ScreencastContents, sessionId: number | undefined): void {
  if (sessionId === undefined || contents.isDestroyed() || !contents.debugger.isAttached()) {
    return;
  }
  void contents.debugger
    .sendCommand("Page.screencastFrameAck", { sessionId })
    .catch(() => undefined);
}

function clearPendingFrame(contents: ScreencastContents, active: ActiveScreencast): void {
  if (active.pendingFrameTimer) {
    clearTimeout(active.pendingFrameTimer);
    active.pendingFrameTimer = null;
  }
  acknowledgeFrame(contents, active.pendingFrame?.sessionId);
  active.pendingFrame = null;
}

function clearNavigationCapture(active: ActiveScreencast): void {
  if (active.navigationCaptureTimer) {
    clearTimeout(active.navigationCaptureTimer);
    active.navigationCaptureTimer = null;
  }
}

function cleanupActive(contents: ScreencastContents, active: ActiveScreencast): void {
  clearPendingFrame(contents, active);
  clearNavigationCapture(active);
  active.captureGeneration += 1;
}

function emitFrame(
  contents: ScreencastContents,
  active: ActiveScreencast,
  frame: PendingScreencastFrame,
): void {
  if (activeByContentsId.get(contents.id) !== active) {
    acknowledgeFrame(contents, frame.sessionId);
    return;
  }
  const seq = (nextSequenceByContentsId.get(contents.id) ?? 0) + 1;
  nextSequenceByContentsId.set(contents.id, seq);
  active.lastFrameSentAt = Date.now();
  try {
    active.onFrame({
      seq,
      dataBase64: frame.dataBase64,
      width: frame.width,
      height: frame.height,
    });
  } finally {
    // CDP uses this acknowledgement as producer backpressure. Acknowledge only
    // after the selected frame has crossed the main-process callback boundary.
    acknowledgeFrame(contents, frame.sessionId);
  }
}

function flushPendingFrame(contents: ScreencastContents, active: ActiveScreencast): void {
  active.pendingFrameTimer = null;
  const pending = active.pendingFrame;
  active.pendingFrame = null;
  if (!pending) {
    return;
  }
  emitFrame(contents, active, pending);
}

function queueFrame(
  contents: ScreencastContents,
  active: ActiveScreencast,
  frame: PendingScreencastFrame,
): void {
  if (activeByContentsId.get(contents.id) !== active) {
    acknowledgeFrame(contents, frame.sessionId);
    return;
  }
  const elapsed = Date.now() - active.lastFrameSentAt;
  if (
    active.minFrameIntervalMs === 0 ||
    active.lastFrameSentAt === 0 ||
    elapsed >= active.minFrameIntervalMs
  ) {
    clearPendingFrame(contents, active);
    emitFrame(contents, active, frame);
    return;
  }

  // Keep the latest throttled frame. Static pages may not produce another
  // compositor update, so dropping every frame inside the interval can freeze
  // the viewer one state behind.
  acknowledgeFrame(contents, active.pendingFrame?.sessionId);
  active.pendingFrame = frame;
  if (!active.pendingFrameTimer) {
    active.pendingFrameTimer = setTimeout(
      () => flushPendingFrame(contents, active),
      Math.max(0, active.minFrameIntervalMs - elapsed),
    );
  }
}

function scheduleNavigationCapture(contents: ScreencastContents, active: ActiveScreencast): void {
  if (activeByContentsId.get(contents.id) !== active) {
    return;
  }
  clearNavigationCapture(active);
  const generation = ++active.captureGeneration;
  active.navigationCaptureTimer = setTimeout(() => {
    active.navigationCaptureTimer = null;
    void captureFallbackFrame(contents, active, generation);
  }, NAVIGATION_CAPTURE_DELAY_MS);
}

async function captureFallbackFrame(
  contents: ScreencastContents,
  active: ActiveScreencast,
  generation: number,
): Promise<void> {
  if (
    activeByContentsId.get(contents.id) !== active ||
    active.captureGeneration !== generation ||
    active.viewportWidth <= 0 ||
    active.viewportHeight <= 0
  ) {
    return;
  }
  try {
    const raw = await sendCommandWithTimeout(contents, "Page.captureScreenshot", {
      format: "jpeg",
      quality: active.quality,
      captureBeyondViewport: false,
    });
    if (activeByContentsId.get(contents.id) !== active || active.captureGeneration !== generation) {
      return;
    }
    const dataBase64 =
      raw && typeof raw === "object" && typeof (raw as { data?: unknown }).data === "string"
        ? (raw as { data: string }).data
        : "";
    if (!dataBase64) {
      return;
    }
    queueFrame(contents, active, {
      dataBase64,
      width: active.viewportWidth,
      height: active.viewportHeight,
    });
  } catch {
    // Best effort: live Page.screencastFrame events remain authoritative.
  }
}

function isNavigationPaintEvent(
  method: string,
  params: Record<string, unknown> | undefined,
): boolean {
  if (method === "Page.loadEventFired") {
    return true;
  }
  if (method !== "Page.frameNavigated") {
    return false;
  }
  const frame = params?.frame;
  return Boolean(frame && typeof frame === "object" && !("parentId" in frame));
}

function handleScreencastFrameMessage(
  contents: ScreencastContents,
  active: ActiveScreencast | undefined,
  params: Record<string, unknown>,
): void {
  const sessionId = typeof params.sessionId === "number" ? params.sessionId : undefined;
  if (!active) {
    acknowledgeFrame(contents, sessionId);
    return;
  }
  const dataBase64 = typeof params.data === "string" ? params.data : "";
  const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
  const width = positiveInteger(metadata?.deviceWidth) || active.viewportWidth;
  const height = positiveInteger(metadata?.deviceHeight) || active.viewportHeight;
  if (!dataBase64 || width <= 0 || height <= 0) {
    acknowledgeFrame(contents, sessionId);
    return;
  }

  active.captureGeneration += 1;
  clearNavigationCapture(active);
  active.viewportWidth = width;
  active.viewportHeight = height;
  queueFrame(contents, active, { sessionId, dataBase64, width, height });
}

function handleDebuggerMessage(
  contents: ScreencastContents,
  method: string,
  params: Record<string, unknown> | undefined,
): void {
  const active = activeByContentsId.get(contents.id);
  if (active && isNavigationPaintEvent(method, params)) {
    scheduleNavigationCapture(contents, active);
    return;
  }
  if (method === "Page.screencastFrame" && params) {
    handleScreencastFrameMessage(contents, active, params);
  }
}

function ensureFrameListener(contents: ScreencastContents): void {
  if (listeningContentsIds.has(contents.id) || !contents.debugger.on) {
    return;
  }
  listeningContentsIds.add(contents.id);
  contents.debugger.on("message", (_event, method, params) => {
    handleDebuggerMessage(contents, method, params);
  });
  contents.once("destroyed", () => {
    listeningContentsIds.delete(contents.id);
    nextSequenceByContentsId.delete(contents.id);
    const active = activeByContentsId.get(contents.id);
    if (active) {
      cleanupActive(contents, active);
      activeByContentsId.delete(contents.id);
    }
  });
}

export async function startScreencast(
  contents: ScreencastContents,
  options: ScreencastOptions,
  onFrame: (frame: ScreencastFramePayload) => void,
): Promise<void> {
  if (!contents.debugger.on) {
    throw new Error("Screencast requires debugger event support");
  }
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
  }
  ensureFrameListener(contents);

  const previous = activeByContentsId.get(contents.id);
  if (previous) {
    cleanupActive(contents, previous);
  }
  const active: ActiveScreencast = {
    onFrame,
    quality: options.quality ?? DEFAULT_QUALITY,
    minFrameIntervalMs: options.minFrameIntervalMs ?? 0,
    viewportWidth: positiveInteger(options.viewportWidth),
    viewportHeight: positiveInteger(options.viewportHeight),
    lastFrameSentAt: 0,
    pendingFrame: null,
    pendingFrameTimer: null,
    navigationCaptureTimer: null,
    captureGeneration: 0,
  };
  activeByContentsId.set(contents.id, active);
  try {
    await sendCommandWithTimeout(contents, "Page.enable");
    await sendCommandWithTimeout(contents, "Page.startScreencast", {
      format: "jpeg",
      quality: active.quality,
      maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
      maxHeight: options.maxHeight ?? DEFAULT_MAX_HEIGHT,
      everyNthFrame: 1,
    });
    scheduleNavigationCapture(contents, active);
  } catch (error) {
    // Do not report a stream as active after CDP rejected startup. Guard the
    // deletion in case a newer start replaced this callback concurrently.
    if (activeByContentsId.get(contents.id) === active) {
      cleanupActive(contents, active);
      activeByContentsId.delete(contents.id);
    }
    throw error;
  }
}

export async function stopScreencast(contents: ScreencastContents): Promise<void> {
  const active = activeByContentsId.get(contents.id);
  if (!active) {
    return;
  }
  activeByContentsId.delete(contents.id);
  cleanupActive(contents, active);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    return;
  }
  await sendCommandWithTimeout(contents, "Page.stopScreencast").catch(() => undefined);
}

export function isScreencastActive(contentsId: number): boolean {
  return activeByContentsId.has(contentsId);
}
