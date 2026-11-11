import type { Rectangle } from "electron";
import { describe, expect, test, vi } from "vitest";
import type { FullPageCaptureImage } from "./full-page-capture.js";
import {
  adaptWebContents,
  HostSnapshotEngineRegistry,
  registerBrowserAutomationIpc,
} from "./ipc.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { getPaseoBrowserTabLifecycle } from "../browser-webviews/index.js";

const mainLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: mainLog }));

class FakeImage implements FullPageCaptureImage {
  public toPNG(): Uint8Array {
    return new Uint8Array([137, 80, 78, 71]);
  }

  public toBitmap(): Uint8Array {
    return new Uint8Array(640 * 480 * 4);
  }

  public getSize(): { width: number; height: number } {
    return { width: 640, height: 480 };
  }
}

class FakeDebugger {
  public attachedProtocolVersions: string[] = [];
  public commands: Array<{ command: string; params: Record<string, unknown> }> = [];
  public blockCommands = false;
  public readonly blockedCommandNames = new Set<string>();
  public readonly failedCommandNames = new Set<string>();
  public readonly failedCommandErrors = new Map<string, Error>();
  public beforeCommand: ((command: string) => void) | null = null;
  private messageListener:
    | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
    | null = null;
  private detachListener: (() => void) | null = null;
  private readonly blockedCommands: Array<() => void> = [];

  public isAttached(): boolean {
    return this.attachedProtocolVersions.length > 0;
  }

  public attach(protocolVersion?: string): void {
    this.attachedProtocolVersions.push(protocolVersion ?? "");
  }

  public async sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ command, params: params ?? {} });
    this.beforeCommand?.(command);
    const commandError = this.failedCommandErrors.get(command);
    if (commandError) {
      throw commandError;
    }
    if (this.failedCommandNames.has(command)) {
      throw new Error(`${command} failed`);
    }
    if (this.blockCommands || this.blockedCommandNames.has(command)) {
      await new Promise<void>((resolve) => {
        this.blockedCommands.push(resolve);
      });
    }
    if (command === "Runtime.evaluate" && typeof params?.expression === "string") {
      return { result: { value: true } };
    }
    if (command === "Runtime.callFunctionOn") {
      return { result: { value: true } };
    }
    return { ok: true };
  }

  public on(
    event: "message" | "detach",
    listener:
      | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
      | (() => void),
  ): void {
    if (event === "detach") {
      this.detachListener = listener;
      return;
    }
    this.messageListener = listener;
  }

  public emitMessage(method: string, params?: Record<string, unknown>): void {
    if (!this.messageListener) {
      throw new Error("Debugger message listener was not registered");
    }
    this.messageListener({}, method, params);
  }

  public emitDetach(): void {
    this.attachedProtocolVersions.length = 0;
    this.detachListener?.();
  }

  public finishNextCommand(): void {
    const resolve = this.blockedCommands.shift();
    if (!resolve) {
      throw new Error("No command is blocked");
    }
    resolve();
  }
}

type ConsoleMessageListener = (
  event: unknown,
  level: unknown,
  message: unknown,
  line: unknown,
  sourceId: unknown,
) => void;

class FakeWebContents {
  public readonly debugger = new FakeDebugger();
  public readonly inputEvents: IsolatedKeyboardInputEvent[] = [];
  public readonly insertedTexts: string[] = [];
  public readonly loadedUrls: string[] = [];
  public readonly captures: Array<{
    rect: Rectangle | undefined;
    options: { stayHidden?: boolean } | undefined;
  }> = [];
  public readonly invalidations: string[] = [];
  private consoleMessageListener: ConsoleMessageListener | null = null;
  private readonly destroyedListeners: Array<() => void> = [];
  public destroyed = false;

  public constructor(private readonly webContentsId: number) {
    // Electron's own page-dialog listener, which shows a native message box (delta 93 replaces it).
    this.on("-run-dialog", () => {
      throw new Error("Electron's native dialog listener must never run");
    });
  }

  public listenerCount(event: string): number {
    return this.eventListeners.get(event)?.length ?? 0;
  }

  public removeAllListeners(event: string): void {
    this.eventListeners.delete(event);
  }

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

  public getURL(): string {
    return "https://example.com";
  }

  public getTitle(): string {
    return "Example";
  }

  public canGoBack(): boolean {
    return false;
  }

  public canGoForward(): boolean {
    return false;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async insertText(text: string): Promise<void> {
    this.insertedTexts.push(text);
  }

  public readonly mainFrameScripts: Array<{ code: string; userGesture?: boolean }> = [];
  public readonly mainFrame = {
    executeJavaScript: async (code: string, userGesture?: boolean): Promise<unknown> => {
      if (typeof userGesture !== "boolean") {
        throw new TypeError("userGesture must be a boolean");
      }
      this.mainFrameScripts.push({ code, userGesture });
      return null;
    },
  };

  /** webContents.executeJavaScript waits for a load to stop; the adapter must never use it. */
  public executeJavaScript(): Promise<unknown> {
    throw new Error("webContents.executeJavaScript must not be used");
  }

  public async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  public goBack(): void {}

  public goForward(): void {}

  public reload(): void {}

  public async capturePage(
    rect?: Rectangle,
    options?: { stayHidden?: boolean },
  ): Promise<FullPageCaptureImage> {
    this.captures.push({ rect, options });
    return new FakeImage();
  }

  public invalidate(): void {
    this.invalidations.push("invalidate");
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    this.inputEvents.push(event);
  }

  public readonly eventListeners = new Map<string, Array<(...args: never[]) => void>>();

  public addListener(event: string, listener: (...args: never[]) => void): void {
    this.eventListeners.set(event, [...(this.eventListeners.get(event) ?? []), listener]);
  }

  public removeListener(event: string, listener: (...args: never[]) => void): void {
    this.eventListeners.set(
      event,
      (this.eventListeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  public on(
    event: string,
    listener: ConsoleMessageListener | ((...args: unknown[]) => void),
  ): void {
    if (event === "console-message") {
      this.consoleMessageListener = listener as ConsoleMessageListener;
      return;
    }
    // Renderer health (delta 92) listens for unresponsive, responsive, render-process-gone, and
    // did-start-loading.
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener);
    this.eventListeners.set(event, list);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.push(listener);
  }

  public emitConsoleMessage(input: {
    level: unknown;
    message: unknown;
    line: unknown;
    sourceId: unknown;
  }): void {
    if (!this.consoleMessageListener) {
      throw new Error("Console listener was not registered");
    }
    this.consoleMessageListener({}, input.level, input.message, input.line, input.sourceId);
  }

  public destroy(): void {
    this.destroyed = true;
    this.debugger.emitDetach();
    for (const listener of this.destroyedListeners) listener();
  }
}

describe("browser automation IPC adapter", () => {
  test("runs page scripts in the main frame, which does not wait for loading to stop", async () => {
    const contents = new FakeWebContents(40);
    const tab = adaptWebContents(contents);
    await tab.executeJavaScript("document.title", true);
    expect(contents.mainFrameScripts).toEqual([{ code: "document.title", userGesture: true }]);
  });

  test("answers the renderer's ping with nothing but a free main thread", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerBrowserAutomationIpc({
      ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    });
    const ping = handlers.get("paseo:browser:ping");
    expect(ping).toBeDefined();
    expect(await ping?.({})).toBe(true);
  });

  test("isolates snapshot refs by host window and releases them on destruction", () => {
    const registry = new HostSnapshotEngineRegistry();
    const firstHost = new FakeHostWebContents(1);
    const secondHost = new FakeHostWebContents(2);

    const firstEngine = registry.get(firstHost);
    expect(registry.get(firstHost)).toBe(firstEngine);
    expect(registry.get(secondHost)).not.toBe(firstEngine);

    firstHost.destroy();
    expect(registry.get(new FakeHostWebContents(1))).not.toBe(firstEngine);
  });

  test("sends contained keyboard and text input directly to the guest", async () => {
    const contents = new FakeWebContents(19);
    const tab = adaptWebContents(contents);

    tab.sendInputEvent({ type: "keyDown", keyCode: "Enter", skipIfUnhandled: true });
    await tab.insertText("browser text");

    expect(contents.inputEvents).toEqual([
      { type: "keyDown", keyCode: "Enter", skipIfUnhandled: true },
    ]);
    expect(contents.insertedTexts).toEqual(["browser text"]);
  });

  test("delegates viewport capture to the guest without a renderer prep bridge", async () => {
    const contents = new FakeWebContents(20);
    const tab = adaptWebContents(contents);

    const image = await tab.capturePage({ stayHidden: false });
    tab.invalidate();

    expect(image.getSize()).toEqual({ width: 640, height: 480 });
    expect(contents.captures).toEqual([{ rect: undefined, options: { stayHidden: false } }]);
    expect(contents.invalidations).toEqual(["invalidate"]);
  });

  test("main-frame commits carry the HTTP response code, and only for HTTP documents", () => {
    const contents = new FakeWebContents(23);
    const tab = adaptWebContents(contents);
    const commits: unknown[] = [];

    const unsubscribe = tab.onMainFrameNavigated?.((url, response) =>
      commits.push({ url, response }),
    );
    contents.emit("did-navigate", {}, "https://example.com/missing", 404, "Not Found");
    contents.emit("did-navigate", {}, "data:text/html,hi", -1, "");
    unsubscribe?.();
    contents.emit("did-navigate", {}, "https://example.com/after", 200, "OK");

    expect(commits).toEqual([
      {
        url: "https://example.com/missing",
        response: { httpStatus: 404, httpStatusText: "Not Found" },
      },
      { url: "data:text/html,hi", response: undefined },
    ]);
  });

  test("names numeric console severities", () => {
    const contents = new FakeWebContents(22);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({ level: 3, message: "boom", line: 1, sourceId: "" });
    contents.emitConsoleMessage({ level: 2, message: "careful", line: 2, sourceId: "" });

    expect(tab.getConsoleMessages?.().map((entry) => entry.level)).toEqual(["error", "warning"]);
  });

  test("marks console messages logged before the latest main-frame navigation", () => {
    const contents = new FakeWebContents(91);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({ level: 3, message: "old page", line: 1, sourceId: "" });
    contents.emit("did-navigate", {}, "https://example.com/next", 200, "OK");
    contents.emitConsoleMessage({ level: 3, message: "new page", line: 1, sourceId: "" });

    expect(
      tab.getConsoleMessages?.().map((entry) => [entry.message, entry.previousPage ?? false]),
    ).toEqual([
      ["old page", true],
      ["new page", false],
    ]);
  });

  test("collects console messages until the guest is destroyed", () => {
    const contents = new FakeWebContents(21);
    const tab = adaptWebContents(contents);

    contents.emitConsoleMessage({
      level: "warning",
      message: "hello",
      line: 12,
      sourceId: "https://example.com/app.js",
    });

    expect(tab.getConsoleMessages?.()).toEqual([
      {
        level: "warning",
        message: "hello",
        line: 12,
        source: "https://example.com/app.js",
        timestamp: expect.any(Number),
      },
    ]);

    expect(() => contents.destroy()).not.toThrow();

    expect(tab.getConsoleMessages?.()).toEqual([]);
  });

  test("attaches the debugger before sending a CDP command", async () => {
    const contents = new FakeWebContents(22);
    const tab = adaptWebContents(contents);

    const result = await tab.sendDebugCommand?.("Page.captureScreenshot", {
      format: "png",
    });

    expect(result).toEqual({ ok: true });
    expect(contents.debugger.attachedProtocolVersions).toEqual(["1.3"]);
    expect(contents.debugger.commands).toEqual([
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);
  });

  test("serializes CDP commands per guest contents", async () => {
    const contents = new FakeWebContents(23);
    contents.debugger.blockCommands = true;
    const tab = adaptWebContents(contents);

    const first = tab.sendDebugCommand?.("Input.dispatchMouseEvent", { type: "mouseMoved" });
    const second = tab.sendDebugCommand?.("Page.captureScreenshot", { format: "png" });
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
    ]);

    contents.debugger.finishNextCommand();
    await flushMicrotasks();

    expect(contents.debugger.commands).toEqual([
      { command: "Input.dispatchMouseEvent", params: { type: "mouseMoved" } },
      { command: "Page.captureScreenshot", params: { format: "png" } },
    ]);

    contents.debugger.finishNextCommand();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  test("page dialogs reach Daseo's owner, never Electron's native listener (delta 93)", async () => {
    const contents = new FakeWebContents(24);
    const tab = adaptWebContents(contents);
    const answers: Array<[boolean, string]> = [];

    const record = (accept: boolean, text: string) => answers.push([accept, text]);
    const outcome = tab.pageDialogs?.runCommand({ returnWhenHeld: true }, async () => {
      contents.emit("-run-dialog", { dialogType: "confirm", messageText: "Delete item?" }, record);
      return new Promise<never>(() => {});
    });

    await expect(outcome).resolves.toMatchObject({
      kind: "held",
      dialog: { type: "confirm", message: "Delete item?", holder: "agent" },
      dialogs: [],
    });
    expect(contents.listenerCount("-run-dialog")).toBe(1);
    expect(tab.pageDialogs?.current()).toMatchObject({ type: "confirm" });
    expect(answers).toEqual([]);

    expect(tab.pageDialogs?.answer({ accept: true, by: "agent" })).toMatchObject({
      type: "confirm",
      action: "accepted",
    });
    expect(answers).toEqual([[true, ""]]);
    expect(tab.pageDialogs?.current()).toBeNull();
  });

  test("a dialog a page opens while it loads is answered at once, so the navigation finishes (delta 92)", async () => {
    const contents = new FakeWebContents(41);
    let finishLoad = () => {};
    contents.loadURL = async (url: string) => {
      contents.loadedUrls.push(url);
      // An alert in an inline script holds the load until it is answered.
      await new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
    };
    const tab = adaptWebContents(contents);
    const answers: boolean[] = [];
    const answerAlert = (accept: boolean) => {
      answers.push(accept);
      finishLoad();
    };

    const navigated = tab.pageDialogs?.runCommand({ returnWhenHeld: true }, async () => {
      const load = tab.loadURL("https://site.example/welcome");
      await flushMicrotasks();
      contents.emit(
        "-run-dialog",
        { dialogType: "alert", messageText: "Welcome", frame: { url: "https://site.example/" } },
        answerAlert,
      );
      await load;
      return "loaded";
    });

    await expect(navigated).resolves.toEqual({
      kind: "done",
      result: "loaded",
      dialogs: [
        {
          type: "alert",
          message: "Welcome",
          action: "accepted",
          timestamp: expect.any(Number),
          url: "https://site.example/",
        },
      ],
    });
    expect(answers).toEqual([true]);
  });

  test("lets a page with a beforeunload handler be left", () => {
    const contents = new FakeWebContents(42);
    adaptWebContents(contents);
    const preventDefault = vi.fn();

    contents.emit("will-prevent-unload", { preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

class FakeHostWebContents {
  private destroyedListener: (() => void) | null = null;

  public constructor(public readonly id: number) {}

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyedListener?.();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("browser tab lifecycle holds", () => {
  test("a pixel capture runs with the tab held awake", async () => {
    const lifecycle = getPaseoBrowserTabLifecycle();
    const runAwake = vi.spyOn(lifecycle, "runAwake");
    try {
      const tab = adaptWebContents(new FakeWebContents(9101));
      await expect(tab.withFrameProduction(async () => "pixels")).resolves.toBe("pixels");
      expect(runAwake).toHaveBeenCalledWith(9101, expect.any(Function));
    } finally {
      runAwake.mockRestore();
    }
  });

  test("a phone stream holds the tab from stream start until stream stop", async () => {
    const lifecycle = getPaseoBrowserTabLifecycle();
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const hold = vi.spyOn(lifecycle, "hold").mockImplementation(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    });
    try {
      const tab = adaptWebContents(new FakeWebContents(9102));
      await tab.startScreencast?.({}, () => {});
      await tab.startScreencast?.({ quality: 60 }, () => {});
      expect(hold).toHaveBeenCalledTimes(1);
      expect(releases[0]).not.toHaveBeenCalled();

      await tab.stopScreencast?.();
      expect(releases[0]).toHaveBeenCalledTimes(1);
    } finally {
      hold.mockRestore();
    }
  });
});
