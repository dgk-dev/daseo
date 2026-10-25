import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import {
  electronLogInitializeOptions,
  forwardAppRendererConsole,
  rendererConsoleLevel,
} from "./renderer-console-log.js";

class FakeContents extends EventEmitter {
  public constructor(public readonly session: object) {
    super();
  }
}

describe("electronLogInitializeOptions", () => {
  test("registers the preload on the given sessions only and leaves the console spy off", () => {
    const appSession = {};
    const options = electronLogInitializeOptions(() => [appSession]);
    expect(options.getSessions()).toEqual([appSession]);
    // electron-log 5.4.3 initialize.js destructures the singular name.
    expect(options.includeFutureSession).toBe(false);
    expect(options.includeFutureSessions).toBe(false);
    expect(options.preload).toBe(true);
    expect(options.spyRendererConsole).toBe(false);
  });
});

describe("forwardAppRendererConsole", () => {
  function setup() {
    const app = new EventEmitter();
    const browserProfile = {};
    const messages: unknown[] = [];
    forwardAppRendererConsole({
      app,
      logger: { processMessage: (message) => messages.push(message) },
      isBrowserProfileSession: (session) => session === browserProfile,
    });
    return { app, browserProfile, messages };
  }

  test("logs Daseo's own renderer console", () => {
    const { app, messages } = setup();
    const contents = new FakeContents({});
    app.emit("web-contents-created", {}, contents);

    contents.emit("console-message", { level: "warning", message: "slow frame" });

    expect(messages).toEqual([
      {
        data: ["slow frame"],
        date: expect.any(Date),
        level: "warn",
        variables: { processType: "renderer" },
      },
    ]);
  });

  test("never listens to browser profile pages", () => {
    const { app, browserProfile, messages } = setup();
    const page = new FakeContents(browserProfile);
    app.emit("web-contents-created", {}, page);

    page.emit("console-message", { level: "error", message: "site error" });

    expect(page.listenerCount("console-message")).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe("rendererConsoleLevel", () => {
  test("maps Electron's named and numeric levels", () => {
    expect(rendererConsoleLevel({ level: "debug" })).toBe("debug");
    expect(rendererConsoleLevel({ level: "info" })).toBe("info");
    expect(rendererConsoleLevel({ level: "warning" })).toBe("warn");
    expect(rendererConsoleLevel({ level: "error" })).toBe("error");
    expect(rendererConsoleLevel({ level: 3 })).toBe("error");
    expect(rendererConsoleLevel({ level: 0 })).toBe("debug");
    expect(rendererConsoleLevel({})).toBe("info");
  });
});
