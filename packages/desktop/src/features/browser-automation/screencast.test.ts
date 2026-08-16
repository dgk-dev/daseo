import { afterEach, describe, expect, test, vi } from "vitest";

import {
  isScreencastActive,
  startScreencast,
  stopScreencast,
  type ScreencastContents,
} from "./screencast";

function createContents(id: number) {
  let messageHandler:
    | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
    | null = null;
  let destroyedHandler: (() => void) | null = null;
  let attached = false;
  let destroyed = false;
  const sendCommand = vi.fn(async () => undefined as unknown);
  const contents: ScreencastContents = {
    id,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand,
      on: (_event, handler) => {
        messageHandler = handler;
      },
    },
    isDestroyed: () => destroyed,
    once: (_event, handler) => {
      destroyedHandler = handler;
    },
  };
  return {
    contents,
    sendCommand,
    message: (method: string, params?: Record<string, unknown>) =>
      messageHandler?.(undefined, method, params),
    frame: (params: Record<string, unknown>) =>
      messageHandler?.(undefined, "Page.screencastFrame", params),
    destroy: () => {
      destroyed = true;
      destroyedHandler?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("browser screencast lifecycle", () => {
  test("clears active state when CDP rejects stream startup", async () => {
    const harness = createContents(9101);
    harness.sendCommand.mockRejectedValueOnce(new Error("CDP unavailable"));

    await expect(startScreencast(harness.contents, {}, vi.fn())).rejects.toThrow("CDP unavailable");

    expect(isScreencastActive(harness.contents.id)).toBe(false);
  });

  test("forwards valid frames, acknowledges them, and stops cleanly", async () => {
    const harness = createContents(9102);
    const onFrame = vi.fn();
    await startScreencast(harness.contents, { quality: 75 }, onFrame);

    harness.frame({
      sessionId: 7,
      data: "base64-jpeg",
      metadata: { deviceWidth: 800.4, deviceHeight: 600.4 },
    });

    expect(onFrame).toHaveBeenCalledWith({
      seq: 1,
      dataBase64: "base64-jpeg",
      width: 800,
      height: 600,
    });
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.screencastFrameAck", {
      sessionId: 7,
    });
    await stopScreencast(harness.contents);
    expect(isScreencastActive(harness.contents.id)).toBe(false);
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.stopScreencast");
  });

  test("drops lifecycle state when the webview is destroyed", async () => {
    const harness = createContents(9103);
    await startScreencast(harness.contents, {}, vi.fn());
    expect(isScreencastActive(harness.contents.id)).toBe(true);

    harness.destroy();

    expect(isScreencastActive(harness.contents.id)).toBe(false);
    await expect(stopScreencast(harness.contents)).resolves.toBeUndefined();
  });

  test("holds CDP acknowledgements while throttling and emits the newest pending frame", async () => {
    vi.useFakeTimers();
    const harness = createContents(9104);
    const onFrame = vi.fn();
    await startScreencast(
      harness.contents,
      { minFrameIntervalMs: 100, viewportWidth: 800, viewportHeight: 600 },
      onFrame,
    );

    harness.frame({
      sessionId: 1,
      data: "first",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    harness.frame({
      sessionId: 2,
      data: "superseded",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    harness.frame({
      sessionId: 3,
      data: "latest",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.screencastFrameAck", {
      sessionId: 2,
    });
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Page.screencastFrameAck", {
      sessionId: 3,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(onFrame).toHaveBeenLastCalledWith({
      seq: 2,
      dataBase64: "latest",
      width: 800,
      height: 600,
    });
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.screencastFrameAck", {
      sessionId: 3,
    });
    await stopScreencast(harness.contents);
  });

  test("captures a fallback frame when a painted static page emits no screencast frame", async () => {
    vi.useFakeTimers();
    const harness = createContents(9105);
    harness.sendCommand.mockImplementation(async (command: string) =>
      command === "Page.captureScreenshot" ? { data: "fallback-jpeg" } : undefined,
    );
    const onFrame = vi.fn();
    await startScreencast(
      harness.contents,
      { quality: 55, viewportWidth: 1024, viewportHeight: 768 },
      onFrame,
    );

    await vi.advanceTimersByTimeAsync(250);

    expect(harness.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "jpeg",
      quality: 55,
      captureBeyondViewport: false,
    });
    expect(onFrame).toHaveBeenCalledWith({
      seq: 1,
      dataBase64: "fallback-jpeg",
      width: 1024,
      height: 768,
    });
    await stopScreencast(harness.contents);
  });

  test("keeps frame sequence monotonic across a stream restart", async () => {
    const harness = createContents(9106);
    const onFirstStreamFrame = vi.fn();
    await startScreencast(
      harness.contents,
      { viewportWidth: 800, viewportHeight: 600 },
      onFirstStreamFrame,
    );
    harness.frame({
      sessionId: 1,
      data: "first",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    await stopScreencast(harness.contents);

    const onSecondStreamFrame = vi.fn();
    await startScreencast(
      harness.contents,
      { viewportWidth: 800, viewportHeight: 600 },
      onSecondStreamFrame,
    );
    harness.frame({
      sessionId: 2,
      data: "second",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });

    expect(onFirstStreamFrame).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
    expect(onSecondStreamFrame).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 }));
    await stopScreencast(harness.contents);
  });
});
