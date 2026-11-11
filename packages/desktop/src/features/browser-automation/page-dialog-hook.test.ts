import { createContext, runInContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  attachPaseoBrowserPageDialogs,
  installPaseoBrowserPromptRestorer,
  isPaseoBrowserPageDialogHookMissing,
  PROMPT_RESTORE_SCRIPT,
  setPaseoBrowserPageDialogSurfacePorts,
  unwatchPaseoBrowserPageDialogs,
  watchPaseoBrowserPageDialogs,
  type PageDialogSurfacePayload,
} from "./page-dialog-hook.js";

const mainLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: mainLog }));

type Listener = (...args: never[]) => void;

class FakeContents {
  public readonly listeners = new Map<string, Listener[]>();
  public readonly commands: Array<{ command: string; params?: Record<string, unknown> }> = [];
  public attached = false;
  public destroyed = false;
  private readonly destroyedListeners: Array<() => void> = [];
  private detachListener: (() => void) | null = null;
  public readonly debugger = {
    isAttached: () => this.attached,
    attach: () => {
      this.attached = true;
    },
    sendCommand: async (command: string, params?: Record<string, unknown>) => {
      this.commands.push({ command, ...(params ? { params } : {}) });
      return {};
    },
    on: (_event: "detach", listener: () => void) => {
      this.detachListener = listener;
    },
  };

  public constructor(
    public readonly id: number,
    withElectronListener = true,
  ) {
    if (withElectronListener) {
      this.on("-run-dialog", () => {
        throw new Error("Electron's native dialog listener ran");
      });
    }
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  public removeAllListeners(event: string): void {
    this.listeners.delete(event);
  }

  public on(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  public once(event: "destroyed", listener: () => void): void {
    this.destroyedListeners.push(listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  public detach(): void {
    this.attached = false;
    this.detachListener?.();
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners) listener();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("page dialog hook (delta 93)", () => {
  test("replaces Electron's -run-dialog listener and answers through the owner", () => {
    const contents = new FakeContents(501);
    const controller = attachPaseoBrowserPageDialogs(contents);
    expect(attachPaseoBrowserPageDialogs(contents)).toBe(controller);
    expect(contents.listenerCount("-run-dialog")).toBe(1);
    expect(isPaseoBrowserPageDialogHookMissing(501)).toBe(false);

    const answers: unknown[] = [];
    contents.emit("-run-dialog", { dialogType: "alert", messageText: "hi" }, (...args: unknown[]) =>
      answers.push(args),
    );
    // No agent, no pane: answered by policy, never left to Electron.
    expect(answers).toEqual([[true, ""]]);
    contents.destroy();
  });

  test("a throwing frame accessor still gets the dialog answered", () => {
    const contents = new FakeContents(502);
    attachPaseoBrowserPageDialogs(contents);
    const frame = {
      get url(): string {
        throw new Error("Render frame was disposed");
      },
    };
    const answers: unknown[] = [];
    contents.emit(
      "-run-dialog",
      { dialogType: "confirm", messageText: "x", frame },
      (...args: unknown[]) => answers.push(args),
    );
    expect(answers).toEqual([[false, ""]]);
    contents.destroy();
  });

  test("an Electron without -run-dialog is reported loudly and left to disableDialogs", () => {
    mainLog.error.mockClear();
    const contents = new FakeContents(503, false);
    attachPaseoBrowserPageDialogs(contents);
    expect(isPaseoBrowserPageDialogHookMissing(503)).toBe(true);
    expect(contents.listenerCount("-run-dialog")).toBe(0);
    expect(mainLog.error).toHaveBeenCalledTimes(1);
    contents.destroy();
    expect(isPaseoBrowserPageDialogHookMissing(503)).toBe(false);
  });

  test("lets every beforeunload through", () => {
    const contents = new FakeContents(504);
    attachPaseoBrowserPageDialogs(contents);
    const preventDefault = vi.fn();
    contents.emit("will-prevent-unload", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    contents.destroy();
  });

  test("-cancel-dialogs closes a held dialog", () => {
    const contents = new FakeContents(505);
    const controller = attachPaseoBrowserPageDialogs(contents);
    const answers: unknown[] = [];
    void controller.runCommand({ returnWhenHeld: true }, () => new Promise<never>(() => {}));
    contents.emit(
      "-run-dialog",
      { dialogType: "confirm", messageText: "x" },
      (...args: unknown[]) => answers.push(args),
    );
    expect(controller.current()).not.toBeNull();
    contents.emit("-cancel-dialogs", { resetState: true });
    expect(controller.current()).toBeNull();
    expect(answers).toEqual([[false, ""]]);
    contents.destroy();
  });

  test("shows a person's dialog only in a host window that watches, and lists it on watch", () => {
    const sent: Array<{ host: number; payload: PageDialogSurfacePayload }> = [];
    setPaseoBrowserPageDialogSurfacePorts({
      locate: (contentsId) =>
        contentsId === 506 ? { browserId: "tab-506", hostWebContentsId: 9 } : null,
      send: (host, payload) => sent.push({ host, payload }),
    });
    const contents = new FakeContents(506);
    const controller = attachPaseoBrowserPageDialogs(contents);
    try {
      // Before the window watches: answered by policy, nothing sent.
      const early: unknown[] = [];
      contents.emit(
        "-run-dialog",
        { dialogType: "confirm", messageText: "early" },
        (...args: unknown[]) => early.push(args),
      );
      expect(early).toEqual([[false, ""]]);
      expect(sent).toEqual([]);

      expect(watchPaseoBrowserPageDialogs(9)).toEqual([]);
      const answers: unknown[] = [];
      contents.emit(
        "-run-dialog",
        { dialogType: "prompt", messageText: "name?", defaultPromptText: "Ada" },
        (...args: unknown[]) => answers.push(args),
      );
      expect(sent).toEqual([
        {
          host: 9,
          payload: {
            browserId: "tab-506",
            dialog: expect.objectContaining({
              type: "prompt",
              message: "name?",
              defaultValue: "Ada",
              holder: "person",
            }),
          },
        },
      ]);
      expect(watchPaseoBrowserPageDialogs(9)).toEqual([
        { browserId: "tab-506", dialog: expect.objectContaining({ message: "name?" }) },
      ]);

      const dialogId = controller.current()?.id ?? "";
      controller.answer({ accept: true, promptText: "Grace", by: "person", dialogId });
      expect(answers).toEqual([[true, "Grace"]]);
      expect(sent.at(-1)).toEqual({
        host: 9,
        payload: { browserId: "tab-506", dialog: null, dialogId },
      });
    } finally {
      unwatchPaseoBrowserPageDialogs(9);
      setPaseoBrowserPageDialogSurfacePorts(null);
      contents.destroy();
    }
  });

  test("the prompt restorer registers once per DevTools session, again after a detach", async () => {
    const contents = new FakeContents(507);
    const queue = new CdpSessionQueue();
    installPaseoBrowserPromptRestorer(contents, queue);
    installPaseoBrowserPromptRestorer(contents, queue);
    await flush();
    const registration = [
      { command: "Page.enable" },
      {
        command: "Page.addScriptToEvaluateOnNewDocument",
        params: { source: PROMPT_RESTORE_SCRIPT, runImmediately: true },
      },
    ];
    expect(contents.commands).toEqual(registration);

    contents.emit("did-start-loading");
    await flush();
    expect(contents.commands).toEqual(registration);

    contents.detach();
    contents.emit("did-start-loading");
    await flush();
    expect(contents.commands).toEqual([...registration, ...registration]);
    contents.destroy();
  });
});

describe("prompt restore script", () => {
  function page(input: { top?: boolean; href?: string } = {}) {
    const context = createContext({});
    runInContext(
      `
      globalThis.window = globalThis;
      window.top = ${input.top === false ? "{}" : "window"};
      window.location = { href: ${JSON.stringify(input.href ?? "https://site.example/")} };
      // Electron's replacement, which throws.
      window.prompt = function () { throw new Error("prompt() is not supported."); };
      window.nativeCalls = [];
      const nativePrompt = function prompt(message, defaultValue) {
        window.nativeCalls.push({ self: this === window.parentWindow, args: [...arguments] });
        return "answer:" + message;
      };
      const realToString = Function.prototype.toString;
      Function.prototype.toString = function () {
        return this === nativePrompt ? "function prompt() { [native code] }" : realToString.call(this);
      };
      window.parentWindow = window;
      window.document = {
        body: {
          appendChild(frame) { frame.contentWindow = { prompt: nativePrompt }; this.frames.push(frame); },
          frames: [],
        },
        documentElement: null,
        createElement() {
          return { style: {}, remove() { window.document.body.removed = (window.document.body.removed || 0) + 1; } };
        },
      };
      `,
      context,
    );
    return context;
  }

  test("routes prompt to the browser's own prompt, called on the page window", () => {
    const context = page();
    const before = runInContext("Object.keys(window).sort()", context) as string[];
    runInContext(PROMPT_RESTORE_SCRIPT, context);
    expect(runInContext("Object.keys(window).sort()", context)).toEqual(before);
    expect(runInContext("prompt('name?', 'Ada')", context)).toBe("answer:name?");
    expect(runInContext("prompt('again')", context)).toBe("answer:again");
    expect(runInContext("window.nativeCalls", context)).toEqual([
      { self: true, args: ["name?", "Ada"] },
      { self: true, args: ["again"] },
    ]);
    // One temporary frame, removed at once; the native prompt is kept afterwards.
    expect(runInContext("document.body.frames.length", context)).toBe(1);
    expect(runInContext("document.body.removed", context)).toBe(1);
  });

  test("leaves about:blank child frames alone (the native prompt is taken from one)", () => {
    const context = page({ top: false, href: "about:blank" });
    runInContext(PROMPT_RESTORE_SCRIPT, context);
    expect(() => runInContext("prompt('x')", context)).toThrow("prompt() is not supported.");
  });
});
