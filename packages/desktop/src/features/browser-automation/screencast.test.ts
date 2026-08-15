import { describe, expect, test, vi } from "vitest";

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
    frame: (params: Record<string, unknown>) =>
      messageHandler?.(undefined, "Page.screencastFrame", params),
    destroy: () => {
      destroyed = true;
      destroyedHandler?.();
    },
  };
}

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
});
