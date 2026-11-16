import { describe, expect, it } from "vitest";
import {
  runRequestedNavigation,
  type RequestedNavigationCommit,
  type RequestedNavigationSource,
} from "./requested-navigation.js";

// Event orders below are the ones Electron 44.10.2 reported in the capture harness group
// `tab-reliability` (delta 123).
class FakeNavigationSource implements RequestedNavigationSource {
  public loading = false;
  public destroyed = false;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  public isLoading(): boolean {
    return this.loading;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public onMainFrameNavigationStarted(
    listener: (url: string, sameDocument: boolean) => void,
  ): () => void {
    return this.add("start", listener);
  }

  public onMainFrameNavigated(
    listener: (url: string, response?: RequestedNavigationCommit["response"]) => void,
  ): () => void {
    return this.add("commit", listener);
  }

  public onMainFrameLoadFailed(
    listener: (url: string, code: number, description: string) => void,
  ): () => void {
    return this.add("fail", listener);
  }

  public onMainFrameDomReady(listener: () => void): () => void {
    return this.add("dom-ready", listener);
  }

  public onStopLoading(listener: () => void): () => void {
    return this.add("stop", listener);
  }

  public start(url: string, sameDocument = false): void {
    this.loading = true;
    this.emit("start", url, sameDocument);
  }

  public commit(url: string, httpStatus?: number): void {
    this.emit(
      "commit",
      url,
      httpStatus === undefined ? undefined : { httpStatus, httpStatusText: "OK" },
    );
  }

  public fail(url: string, code: number, description = ""): void {
    this.emit("fail", url, code, description);
  }

  public domReady(): void {
    this.emit("dom-ready");
  }

  public stop(): void {
    this.loading = false;
    this.emit("stop");
  }

  public listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  private add(event: string, listener: (...args: never[]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runRequestedNavigation", () => {
  it("answers at its own commit when the new page holds a request open forever", async () => {
    const source = new FakeNavigationSource();
    const load = deferred(); // loadURL never settles: the page never finishes loading
    const stages: string[] = [];
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/hang",
      load: () => {
        source.start("https://example.com/hang");
        return load.promise;
      },
      log: (stage) => stages.push(stage),
    });

    source.commit("https://example.com/hang", 200);
    source.domReady();

    await expect(outcome).resolves.toEqual({
      kind: "committed",
      commit: {
        url: "https://example.com/hang",
        response: { httpStatus: 200, httpStatusText: "OK" },
      },
      loaded: false,
    });
    expect(stages).toEqual(["loadURL", "did-start-navigation", "commit", "dom-ready", "outcome"]);
    expect(source.listenerCount()).toBe(0);
  });

  it("ignores the abort of the load it replaced and reports its own commit", async () => {
    const source = new FakeNavigationSource();
    source.loading = true; // the old page is still loading an image
    const load = deferred();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/next",
      load: () => {
        source.start("https://example.com/next");
        return load.promise;
      },
    });

    source.fail("https://example.com/hanging", -3);
    load.reject(new Error(" (-3) loading 'https://example.com/hanging'"));
    await tick();
    source.commit("https://example.com/next", 200);
    source.domReady();

    await expect(outcome).resolves.toMatchObject({
      kind: "committed",
      commit: { url: "https://example.com/next", response: { httpStatus: 200 } },
    });
  });

  it("never takes a commit from before its own start", async () => {
    const source = new FakeNavigationSource();
    const load = deferred();
    let startNow: () => void = () => {};
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/requested",
      load: () => {
        startNow = () => source.start("https://example.com/requested");
        return load.promise;
      },
    });

    source.commit("https://example.com/older-pending", 200);
    source.domReady();
    startNow();
    source.commit("https://example.com/requested", 201);
    source.domReady();

    await expect(outcome).resolves.toMatchObject({
      kind: "committed",
      commit: { url: "https://example.com/requested", response: { httpStatus: 201 } },
    });
  });

  it("reports a navigation that replaced it before it committed", async () => {
    const source = new FakeNavigationSource();
    const load = deferred();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/a",
      load: () => {
        source.start("https://example.com/a");
        return load.promise;
      },
    });

    source.start("https://example.com/b");
    source.commit("https://example.com/b", 200);

    await expect(outcome).resolves.toMatchObject({
      kind: "superseded",
      commit: { url: "https://example.com/b" },
    });
  });

  it("fails with its own net error, not the abort of the old load", async () => {
    const source = new FakeNavigationSource();
    source.loading = true;
    const load = deferred();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://nowhere.invalid/",
      load: () => {
        source.start("https://nowhere.invalid/");
        return load.promise;
      },
    });

    source.fail("https://example.com/hanging", -3);
    load.reject(new Error(" (-3) loading 'https://example.com/hanging'"));
    await tick();
    source.fail("https://nowhere.invalid/", -105, "ERR_NAME_NOT_RESOLVED");
    source.stop();

    await expect(outcome).resolves.toMatchObject({
      kind: "failed",
      commit: null,
      netError: { code: -105, description: "ERR_NAME_NOT_RESOLVED" },
    });
  });

  it("fails a navigation that ended in a download", async () => {
    const source = new FakeNavigationSource();
    const load = deferred();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/file.csv",
      load: () => {
        source.start("https://example.com/file.csv");
        return load.promise;
      },
    });

    source.fail("https://example.com/file.csv", -3, "ERR_ABORTED");
    source.stop();
    load.reject(new Error("ERR_ABORTED (-3) loading 'https://example.com/file.csv'"));

    const result = await outcome;
    expect(result).toMatchObject({ kind: "failed", commit: null, netError: null });
    expect(result.kind === "failed" ? String(result.error) : "").toContain("ERR_ABORTED (-3)");
  });

  it("keeps a non-abort error after its commit a failure", async () => {
    const source = new FakeNavigationSource();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/a",
      load: async () => {
        source.start("https://example.com/a");
        source.commit("https://example.com/a");
        throw new Error("ERR_CONNECTION_RESET (-101) loading 'https://example.com/a'");
      },
    });

    await expect(outcome).resolves.toMatchObject({
      kind: "failed",
      commit: { url: "https://example.com/a" },
    });
  });

  it("answers a same-document move when its load settles", async () => {
    const source = new FakeNavigationSource();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/a#b",
      load: async () => {
        source.start("https://example.com/a#b", true);
      },
    });

    await expect(outcome).resolves.toEqual({ kind: "loaded", commit: null });
  });

  it("answers a finished load that committed", async () => {
    const source = new FakeNavigationSource();
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/plain",
      load: async () => {
        source.start("https://example.com/plain");
        source.commit("https://example.com/plain", 200);
      },
    });

    await expect(outcome).resolves.toMatchObject({ kind: "committed", loaded: true });
  });

  it("ignores the finish of the page it replaced when that page was still finishing", async () => {
    const source = new FakeNavigationSource();
    source.loading = true; // the previous navigate answered at dom-ready; its load still runs
    const load = deferred();
    const stages: string[] = [];
    const outcome = runRequestedNavigation({
      contents: source,
      url: "https://example.com/hang",
      load: () => {
        source.start("https://example.com/hang");
        return load.promise;
      },
      log: (stage) => stages.push(stage),
    });

    load.resolve(); // Electron: the old page's did-finish-load resolved this loadURL
    await tick();
    expect(stages).toContain("load-resolved-ignored");
    source.commit("https://example.com/hang", 200);
    source.domReady();

    await expect(outcome).resolves.toMatchObject({
      kind: "committed",
      commit: { url: "https://example.com/hang", response: { httpStatus: 200 } },
    });
  });
});
