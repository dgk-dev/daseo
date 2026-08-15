import { describe, expect, test, vi } from "vitest";
import { BrowserStreamHub, type BrowserStreamStarter } from "./stream-hub.js";

const BROWSER_ID = "0b54f9a2-9d1c-4f6e-89ab-1234567890ab";

function createStarter(overrides?: Partial<BrowserStreamStarter>) {
  const start = vi.fn(async () => ({ ok: true, width: 1200, height: 800 }));
  const stop = vi.fn(async () => undefined);
  return { start, stop, ...overrides } as BrowserStreamStarter & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

describe("BrowserStreamHub", () => {
  test("starts the host stream once for concurrent watchers and fans frames out", async () => {
    const starter = createStarter();
    const hub = new BrowserStreamHub(starter);
    const firstFrames: Uint8Array[] = [];
    const secondFrames: Uint8Array[] = [];

    const [first, second] = await Promise.all([
      hub.watch({
        browserId: BROWSER_ID,
        watcherKey: "client-a",
        send: (bytes) => firstFrames.push(bytes),
      }),
      hub.watch({
        browserId: BROWSER_ID,
        watcherKey: "client-b",
        send: (bytes) => secondFrames.push(bytes),
      }),
    ]);

    expect(first).toEqual({ ok: true, width: 1200, height: 800 });
    expect(second).toEqual({ ok: true, width: 1200, height: 800 });
    expect(starter.start).toHaveBeenCalledTimes(1);

    const frame = new Uint8Array([0x20, 1, 2, 3]);
    hub.routeFrame(BROWSER_ID, frame);
    expect(firstFrames).toEqual([frame]);
    expect(secondFrames).toEqual([frame]);
    hub.routeFrame("other-browser", frame);
    expect(firstFrames).toHaveLength(1);
  });

  test("stops the host stream when the last watcher leaves", async () => {
    const starter = createStarter();
    const hub = new BrowserStreamHub(starter);
    await hub.watch({ browserId: BROWSER_ID, watcherKey: "client-a", send: () => undefined });
    await hub.watch({ browserId: BROWSER_ID, watcherKey: "client-b", send: () => undefined });

    await hub.unwatch(BROWSER_ID, "client-a");
    expect(starter.stop).not.toHaveBeenCalled();

    await hub.unwatch(BROWSER_ID, "client-b");
    expect(starter.stop).toHaveBeenCalledTimes(1);
    expect(hub.getWatcherCount(BROWSER_ID)).toBe(0);
  });

  test("cleans up every subscription for a disconnected client", async () => {
    const starter = createStarter();
    const hub = new BrowserStreamHub(starter);
    await hub.watch({ browserId: BROWSER_ID, watcherKey: "client-a", send: () => undefined });
    await hub.watch({ browserId: "other-browser", watcherKey: "client-a", send: () => undefined });

    await hub.removeConnection("client-a");
    expect(starter.stop).toHaveBeenCalledTimes(2);
  });

  test("propagates a start failure and allows a clean retry", async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "browser_no_host", message: "gone" } })
      .mockResolvedValue({ ok: true, width: 100, height: 100 });
    const starter = createStarter({ start });
    const hub = new BrowserStreamHub(starter);

    const failed = await hub.watch({
      browserId: BROWSER_ID,
      watcherKey: "client-a",
      send: () => undefined,
    });
    expect(failed.ok).toBe(false);

    await hub.unwatch(BROWSER_ID, "client-a");
    expect(starter.stop).not.toHaveBeenCalled();

    const retried = await hub.watch({
      browserId: BROWSER_ID,
      watcherKey: "client-a",
      send: () => undefined,
    });
    expect(retried).toEqual({ ok: true, width: 100, height: 100 });
  });
});
