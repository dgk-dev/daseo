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

interface ActiveScreencast {
  seq: number;
  onFrame: (frame: ScreencastFramePayload) => void;
}

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 1280;
const DEFAULT_QUALITY = 60;

const activeByContentsId = new Map<number, ActiveScreencast>();
const listeningContentsIds = new Set<number>();

function ensureFrameListener(contents: ScreencastContents): void {
  if (listeningContentsIds.has(contents.id) || !contents.debugger.on) {
    return;
  }
  listeningContentsIds.add(contents.id);
  contents.debugger.on("message", (_event, method, params) => {
    if (method !== "Page.screencastFrame" || !params) {
      return;
    }
    const sessionId = params.sessionId;
    void contents.debugger
      .sendCommand("Page.screencastFrameAck", { sessionId })
      .catch(() => undefined);
    const active = activeByContentsId.get(contents.id);
    if (!active) {
      return;
    }
    const data = params.data;
    const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
    const width = Math.round(metadata?.deviceWidth ?? 0);
    const height = Math.round(metadata?.deviceHeight ?? 0);
    if (typeof data !== "string" || width <= 0 || height <= 0) {
      return;
    }
    active.seq += 1;
    active.onFrame({ seq: active.seq, dataBase64: data, width, height });
  });
  contents.once("destroyed", () => {
    listeningContentsIds.delete(contents.id);
    activeByContentsId.delete(contents.id);
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
  const active = { seq: 0, onFrame };
  activeByContentsId.set(contents.id, active);
  try {
    await contents.debugger.sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality ?? DEFAULT_QUALITY,
      maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
      maxHeight: options.maxHeight ?? DEFAULT_MAX_HEIGHT,
      everyNthFrame: 1,
    });
  } catch (error) {
    // Do not report a stream as active after CDP rejected startup. Guard the
    // deletion in case a newer start replaced this callback concurrently.
    if (activeByContentsId.get(contents.id) === active) {
      activeByContentsId.delete(contents.id);
    }
    throw error;
  }
}

export async function stopScreencast(contents: ScreencastContents): Promise<void> {
  if (!activeByContentsId.delete(contents.id)) {
    return;
  }
  if (contents.isDestroyed() || !contents.debugger.isAttached()) {
    return;
  }
  await contents.debugger.sendCommand("Page.stopScreencast").catch(() => undefined);
}

export function isScreencastActive(contentsId: number): boolean {
  return activeByContentsId.has(contentsId);
}
