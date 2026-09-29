import { describe, expect, it } from "vitest";
import { observeTabLoading, tabLoadingInfo, type LoadingEventSource } from "./load-tracker.js";

class FakeLoadingContents implements LoadingEventSource {
  public loading = false;
  private readonly listeners = new Map<string, Array<(url?: string) => void>>();

  public constructor(public readonly id: number) {}

  public isLoading(): boolean {
    return this.loading;
  }

  public onStartLoading(listener: () => void): void {
    this.add("start", listener);
  }

  public onStopLoading(listener: () => void): void {
    this.add("stop", listener);
  }

  public onStartMainFrameNavigation(listener: (url: string) => void): void {
    this.add("navigate", (url) => listener(url ?? ""));
  }

  public onDestroyed(listener: () => void): void {
    this.add("destroyed", listener);
  }

  public emit(event: "start" | "stop" | "navigate" | "destroyed", url?: string): void {
    if (event === "start") this.loading = true;
    if (event === "stop") this.loading = false;
    for (const listener of this.listeners.get(event) ?? []) listener(url);
  }

  private add(event: string, listener: (url?: string) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
}

describe("tab load tracker", () => {
  it("counts from the start of the load and reports the URL being loaded", () => {
    let now = 1_000;
    const contents = new FakeLoadingContents(101);
    observeTabLoading(contents, () => now);

    contents.emit("navigate", "https://slow.test/admin");
    contents.emit("start");
    now += 45_000;

    expect(tabLoadingInfo(101, contents.isLoading(), () => now)).toEqual({
      loadingForMs: 45_000,
      url: "https://slow.test/admin",
    });
  });

  it("does not restart the clock when another navigation starts mid-load", () => {
    let now = 0;
    const contents = new FakeLoadingContents(102);
    observeTabLoading(contents, () => now);

    contents.emit("start");
    now = 10_000;
    contents.emit("start");
    now = 25_000;

    expect(tabLoadingInfo(102, contents.isLoading(), () => now)?.loadingForMs).toBe(25_000);
  });

  it("reports nothing once the load stops, and restarts on the next load", () => {
    let now = 0;
    const contents = new FakeLoadingContents(103);
    observeTabLoading(contents, () => now);

    contents.emit("start");
    now = 5_000;
    contents.emit("stop");
    expect(tabLoadingInfo(103, contents.isLoading(), () => now)).toBeNull();

    now = 9_000;
    contents.emit("start");
    now = 12_000;
    expect(tabLoadingInfo(103, contents.isLoading(), () => now)).toEqual({
      loadingForMs: 3_000,
      url: null,
    });
  });

  it("counts a load already running when observation began from that moment", () => {
    let now = 50_000;
    const contents = new FakeLoadingContents(104);
    contents.loading = true;
    observeTabLoading(contents, () => now);
    now = 58_000;

    expect(tabLoadingInfo(104, contents.isLoading(), () => now)?.loadingForMs).toBe(8_000);
  });

  it("forgets a destroyed tab", () => {
    const contents = new FakeLoadingContents(105);
    observeTabLoading(contents, () => 0);
    contents.emit("start");
    contents.emit("destroyed");

    expect(tabLoadingInfo(105, true, () => 1_000)).toBeNull();
  });
});
