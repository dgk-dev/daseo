import { describe, expect, test } from "vitest";
import {
  PageNotRespondingError,
  RendererHealthMonitor,
  describeRendererHealth,
  type RendererHealthContents,
} from "./renderer-health.js";

type Listener = (...args: unknown[]) => void;

class FakeGuest implements RendererHealthContents {
  public busy = false;
  public destroyed = false;
  public scripts: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private readonly held: Array<() => void> = [];
  public readonly mainFrame = {
    executeJavaScript: (code: string): Promise<unknown> => {
      this.scripts.push(code);
      if (this.busy) {
        return new Promise((resolve) => this.held.push(() => resolve(code === "0" ? 0 : "late")));
      }
      return Promise.resolve(code === "0" ? 0 : "done");
    },
  };

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  public once(event: string, listener: Listener): void {
    this.on(event, listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  public unblock(): void {
    this.busy = false;
    for (const release of this.held.splice(0)) release();
  }
}

function monitor(options: { discarded?: Set<number> } = {}) {
  return new RendererHealthMonitor({
    checkAfterMs: 20,
    pingTimeoutMs: 10,
    precheckTimeoutMs: 15,
    isIntentionalCrash: (id) => options.discarded?.has(id) === true,
  });
}

describe("RendererHealthMonitor", () => {
  test("a page script on a busy page fails with not responding instead of waiting", async () => {
    const health = monitor();
    const guest = new FakeGuest(1);
    health.observe(guest);
    guest.busy = true;
    const started = Date.now();
    await expect(health.runPageScript(guest, "snapshot()", undefined, "tab A")).rejects.toThrow(
      PageNotRespondingError,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(health.get(1)).toMatchObject({ state: "not_responding" });

    // The next command checks once and fails at once while the page stays busy.
    expect(await health.blockingHealth(1)).toMatchObject({ state: "not_responding" });
    // Once the page answers again, commands run.
    guest.unblock();
    expect(await health.blockingHealth(1)).toBeNull();
    await expect(health.runPageScript(guest, "click()", undefined, "tab A")).resolves.toBe("done");
  });

  test("the check before a command fails a busy page at once and passes a healthy one", async () => {
    const health = monitor();
    const guest = new FakeGuest(5);
    health.observe(guest);
    expect(await health.blockingHealth(5)).toBeNull();
    guest.busy = true;
    const started = Date.now();
    expect(await health.blockingHealth(5)).toMatchObject({ state: "not_responding" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(guest.scripts).toEqual(["0", "0"]);
    // A tab the monitor never saw is not blocked.
    expect(await health.blockingHealth(99)).toBeNull();
  });

  test("a slow script whose page still answers keeps running", async () => {
    const health = monitor();
    const guest = new FakeGuest(2);
    health.observe(guest);
    let finish: (value: unknown) => void = () => {};
    guest.mainFrame.executeJavaScript = (code: string) =>
      code === "0"
        ? Promise.resolve(0)
        : new Promise((resolve) => {
            finish = resolve;
          });
    const running = health.runPageScript(guest, "await fetch()", undefined, "tab B");
    await new Promise((resolve) => setTimeout(resolve, 70));
    finish("fetched");
    await expect(running).resolves.toBe("fetched");
    expect(health.get(2)).toBeNull();
  });

  test("a crash is reported until the page loads again; a discard is not a crash", async () => {
    const discarded = new Set<number>();
    const health = monitor({ discarded });
    const guest = new FakeGuest(3);
    health.observe(guest);
    guest.emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
    const crashed = await health.blockingHealth(3);
    expect(crashed).toEqual({ state: "crashed", reason: "oom", exitCode: 9 });
    expect(describeRendererHealth("b-1", crashed!)).toBe(
      "The renderer of tab b-1 crashed (oom, exit code 9). browser_reload reopens the page.",
    );
    guest.emit("did-start-loading");
    expect(health.get(3)).toBeNull();

    discarded.add(3);
    guest.emit("render-process-gone", {}, { reason: "killed" });
    expect(health.get(3)).toBeNull();
  });

  test("Electron's unresponsive and responsive events are honoured too", () => {
    const health = monitor();
    const guest = new FakeGuest(4);
    health.observe(guest);
    guest.emit("unresponsive");
    expect(health.get(4)).toMatchObject({ state: "not_responding" });
    guest.emit("responsive");
    expect(health.get(4)).toBeNull();
    expect(describeRendererHealth("b-4", { state: "not_responding", since: 0 })).toContain(
      "Try browser_reload, or close the tab with browser_close_tab.",
    );
  });
});
