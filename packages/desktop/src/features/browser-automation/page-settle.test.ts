// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import type { InflightRequestTracker } from "./network-capture.js";
import {
  SETTLE_DOM_QUIET_MS,
  SETTLE_NETWORK_QUIET_MS,
  watchPageSettle,
  type SettlePage,
} from "./page-settle.js";

// The page script runs against jsdom's document, so the MutationObserver is real; requests and
// loading are driven by the test.

class JsdomSettlePage implements SettlePage {
  public loading = false;
  public inflight = 0;
  public trackerLost = false;
  public trackerReleased = false;
  public withNetwork = true;
  public trackerNeverAnswers = false;
  private navigationListener: ((url: string, sameDocument: boolean) => void) | null = null;

  public isLoading(): boolean {
    return this.loading;
  }
  public isDestroyed(): boolean {
    return false;
  }
  public async executeJavaScript(code: string): Promise<unknown> {
    // Indirect eval runs the script in the global scope, where jsdom's window lives.
    return (0, eval)(code);
  }
  public onMainFrameNavigationStarted(
    listener: (url: string, sameDocument: boolean) => void,
  ): () => void {
    this.navigationListener = listener;
    return () => {
      this.navigationListener = null;
    };
  }
  public navigationStarted(): void {
    this.navigationListener?.("https://a.test/next", false);
  }
  public getNetworkCapture() {
    if (!this.withNetwork) return undefined;
    return {
      trackInflightRequests: (): Promise<InflightRequestTracker> =>
        this.trackerNeverAnswers
          ? new Promise<InflightRequestTracker>(() => undefined)
          : Promise.resolve({
              inflight: () => this.inflight,
              lost: () => this.trackerLost,
              release: async () => {
                this.trackerReleased = true;
              },
            }),
    };
  }
}

async function settle(page: JsdomSettlePage, timeoutMs: number) {
  const watch = await watchPageSettle(page, { observeDom: true });
  try {
    return await watch.settle({ deadline: Date.now() + timeoutMs });
  } finally {
    await watch.release();
  }
}

const timers: Array<ReturnType<typeof setTimeout>> = [];
function later(ms: number, run: () => void): void {
  timers.push(setTimeout(run, ms));
}
function every(ms: number, run: () => void): void {
  timers.push(setInterval(run, ms));
}

afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  document.body.innerHTML = "";
  delete (window as unknown as Record<symbol, unknown>)[
    Symbol.for("paseo.browser-automation.settle")
  ];
});

describe("page settle (delta 104)", () => {
  test("a quiet page settles in about the quiet window, well under a second", async () => {
    const page = new JsdomSettlePage();

    const outcome = await settle(page, 5_000);

    expect(outcome).toMatchObject({ settled: true });
    expect(outcome.networkWatched).toBeUndefined();
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
      Math.max(SETTLE_DOM_QUIET_MS, SETTLE_NETWORK_QUIET_MS) - 50,
    );
    expect(outcome.elapsedMs).toBeLessThan(700);
    expect(page.trackerReleased).toBe(true);
  });

  test("a request in flight holds the settle until it ends and the page renders", async () => {
    const page = new JsdomSettlePage();
    page.inflight = 1;
    later(500, () => {
      page.inflight = 0;
      document.body.innerHTML = "<p>Loaded results</p>";
    });

    const outcome = await settle(page, 5_000);

    expect(outcome.settled).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(500 + SETTLE_DOM_QUIET_MS - 50);
  });

  test("a DOM that keeps changing settles once it stops", async () => {
    const page = new JsdomSettlePage();
    let count = 0;
    every(50, () => {
      if (count < 8) {
        count += 1;
        document.body.insertAdjacentHTML("beforeend", `<span>${count}</span>`);
      }
    });

    const outcome = await settle(page, 5_000);

    expect(outcome.settled).toBe(true);
    expect(count).toBe(8);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(400 + SETTLE_DOM_QUIET_MS - 50);
  });

  test("a page that never goes quiet ends at the bound and says what kept it busy", async () => {
    const page = new JsdomSettlePage();
    let tick = 0;
    every(40, () => {
      tick += 1;
      document.body.textContent = `tick ${tick}`;
    });

    const outcome = await settle(page, 600);

    expect(outcome.settled).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(600);
    expect(outcome.elapsedMs).toBeLessThan(900);
    expect(outcome.domChangedMsAgo).toBeLessThan(SETTLE_DOM_QUIET_MS);
  });

  test("never-ending requests end at the bound naming them", async () => {
    const page = new JsdomSettlePage();
    page.inflight = 2;

    const outcome = await settle(page, 400);

    expect(outcome).toMatchObject({ settled: false, inflightRequests: 2 });
    expect(outcome.domChangedMsAgo).toBeUndefined();
  });

  test("a navigation during the wait restarts it on the new document", async () => {
    const page = new JsdomSettlePage();
    later(150, () => {
      page.navigationStarted();
      page.loading = true;
    });
    later(600, () => {
      page.loading = false;
    });

    const outcome = await settle(page, 5_000);

    expect(outcome.settled).toBe(true);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(600 + SETTLE_NETWORK_QUIET_MS - 50);
  });

  test("changes inside a same-origin iframe keep the page from settling", async () => {
    const page = new JsdomSettlePage();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    expect(frameDocument).not.toBeNull();
    let tick = 0;
    every(40, () => {
      tick += 1;
      frameDocument!.body.textContent = `frame tick ${tick}`;
    });

    const outcome = await settle(page, 600);

    expect(outcome.settled).toBe(false);
  });

  test("a tab whose requests cannot be watched settles on loading and the DOM, and says so", async () => {
    const page = new JsdomSettlePage();
    page.withNetwork = false;

    expect(await settle(page, 2_000)).toMatchObject({ settled: true, networkWatched: false });

    const lost = new JsdomSettlePage();
    lost.trackerLost = true;
    lost.inflight = 3;
    expect(await settle(lost, 2_000)).toMatchObject({ settled: true, networkWatched: false });
  });

  test("a debugger that does not answer does not hold the action back", async () => {
    const page = new JsdomSettlePage();
    page.trackerNeverAnswers = true;
    const startedAt = Date.now();

    const watch = await watchPageSettle(page, { observeDom: true });
    const armedMs = Date.now() - startedAt;
    const outcome = await watch.settle({ deadline: Date.now() + 2_000 });
    await watch.release();

    expect(armedMs).toBeLessThan(1_300);
    expect(outcome).toMatchObject({ settled: true, networkWatched: false });
  });

  test("an aborted settle returns at once, not settled", async () => {
    const page = new JsdomSettlePage();
    page.inflight = 1;
    const abort = new AbortController();
    later(100, () => abort.abort());

    const watch = await watchPageSettle(page, { observeDom: true });
    const outcome = await watch.settle({ deadline: Date.now() + 5_000, signal: abort.signal });
    await watch.release();

    expect(outcome.settled).toBe(false);
    expect(outcome.elapsedMs).toBeLessThan(400);
  });
});
