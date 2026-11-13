// Daseo delta 104. "Settled" means: the tab is not loading, no request it sent is in flight for
// SETTLE_NETWORK_QUIET_MS, and the DOM (the document, same-origin frames, open shadow roots) has
// not changed for SETTLE_DOM_QUIET_MS with document.readyState "complete". Both windows run at the
// same time, so a page that is already quiet settles in about 200 ms.
//
// The network window is shorter than networkidle's 500 ms (Playwright's value). That window has to
// bridge the gap between one request ending and the next starting; here every request sent after
// the watch was armed is counted while in flight, a chained request starts from the previous
// response's handler within a few milliseconds, and content that arrives re-arms the DOM window.
// Requests sent before arming are not counted: an action sent with `snapshot` arms before the
// action, and a page load is covered by waiting for the tab to stop loading.

import type { InflightRequestTracker, NetworkCaptureControl } from "./network-capture.js";

export const SETTLE_NETWORK_QUIET_MS = 200;
export const SETTLE_DOM_QUIET_MS = 200;
const SETTLE_POLL_INTERVAL_MS = 25;
// Arming waits at most this long for the debugger's Network.enable and the page observer; a tab
// that does not answer is watched without them rather than holding the action back.
const SETTLE_ARM_TIMEOUT_MS = 1_000;

export interface SettlePage {
  isLoading(): boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  onMainFrameNavigationStarted?(listener: (url: string, sameDocument: boolean) => void): () => void;
  getNetworkCapture?(): Pick<NetworkCaptureControl, "trackInflightRequests">;
}

export interface PageSettleOutcome {
  settled: boolean;
  elapsedMs: number;
  /** What was still going on at the deadline; all absent when settled. */
  loading?: true;
  inflightRequests?: number;
  domChangedMsAgo?: number;
  /** False when the tab's requests could not be watched, so only loading and the DOM counted. */
  networkWatched?: false;
}

export interface PageSettleWatch {
  /** Waits until the page settles, the deadline passes, or `signal` aborts (not settled). */
  settle(input: { deadline: number; signal?: AbortSignal }): Promise<PageSettleOutcome>;
  release(): Promise<void>;
}

interface PageDomState {
  quietMs: number;
  readyState: string;
}

/**
 * Starts watching the page's requests (and, with `observeDom`, its DOM) now, so that what an
 * action about to run sends is counted. Release the watch when done.
 */
export async function watchPageSettle(
  page: SettlePage,
  options: { observeDom: boolean },
): Promise<PageSettleWatch> {
  const tracker = await armInflightTracker(page);
  if (options.observeDom && !page.isLoading()) {
    await withinMs(page.executeJavaScript(SETTLE_PAGE_SCRIPT), SETTLE_ARM_TIMEOUT_MS).catch(
      () => undefined,
    );
  }
  let released = false;
  return {
    settle: (input) => settlePage({ page, tracker, ...input }),
    release: async () => {
      if (released) return;
      released = true;
      await tracker?.release().catch(() => undefined);
    },
  };
}

async function armInflightTracker(page: SettlePage): Promise<InflightRequestTracker | null> {
  const capture = page.getNetworkCapture?.();
  if (!capture) return null;
  const tracking = capture.trackInflightRequests();
  try {
    return await withinMs(tracking, SETTLE_ARM_TIMEOUT_MS);
  } catch {
    // A late tracker still counts as a watcher of the Network domain until released.
    void tracking.then((late) => late.release()).catch(() => undefined);
    return null;
  }
}

async function settlePage(input: {
  page: SettlePage;
  tracker: InflightRequestTracker | null;
  deadline: number;
  signal?: AbortSignal;
}): Promise<PageSettleOutcome> {
  const { page, deadline, signal } = input;
  const startedAt = Date.now();
  const dom = new PageDomProbe(page);
  const network = new NetworkQuiet(page, input.tracker);
  // A navigation restarts the network window; the new document's observer restarts the DOM one.
  const stopNavigationWatch = page.onMainFrameNavigationStarted?.(() => {
    network.reset();
    dom.reset();
  });
  try {
    for (;;) {
      const now = Date.now();
      const sample = network.sample(now);
      if (sample.loading) {
        dom.reset();
      } else {
        dom.poll();
      }
      const state = dom.current();
      if (sample.quietMs >= SETTLE_NETWORK_QUIET_MS && domSettled(state)) {
        return { settled: true, elapsedMs: now - startedAt, ...network.watchedField() };
      }
      if (now >= deadline || signal?.aborted || page.isDestroyed()) {
        return unsettledOutcome({ elapsedMs: now - startedAt, sample, state, network });
      }
      await delay(Math.min(SETTLE_POLL_INTERVAL_MS, Math.max(0, deadline - now)));
    }
  } finally {
    stopNavigationWatch?.();
  }
}

interface NetworkSample {
  loading: boolean;
  inflight: number;
  /** How long the tab has been neither loading nor waiting on a request; 0 while it is. */
  quietMs: number;
}

/** Loading and requests in flight, and since when neither has been the case. */
class NetworkQuiet {
  private quietSince: number | null = null;

  public constructor(
    private readonly page: SettlePage,
    private readonly tracker: InflightRequestTracker | null,
  ) {}

  public watched(): boolean {
    return this.tracker !== null && !this.tracker.lost();
  }

  public watchedField(): { networkWatched?: false } {
    return this.watched() ? {} : { networkWatched: false };
  }

  public reset(): void {
    this.quietSince = null;
  }

  public sample(now: number): NetworkSample {
    const loading = this.page.isLoading();
    const inflight = this.tracker !== null && this.watched() ? this.tracker.inflight() : 0;
    if (loading || inflight > 0) {
      this.quietSince = null;
      return { loading, inflight, quietMs: 0 };
    }
    this.quietSince ??= now;
    return { loading, inflight, quietMs: now - this.quietSince };
  }
}

function domSettled(state: PageDomState | null): boolean {
  return state !== null && state.readyState === "complete" && state.quietMs >= SETTLE_DOM_QUIET_MS;
}

function unsettledOutcome(input: {
  elapsedMs: number;
  sample: NetworkSample;
  state: PageDomState | null;
  network: NetworkQuiet;
}): PageSettleOutcome {
  const { sample, state } = input;
  const networkQuiet = !sample.loading && sample.inflight === 0;
  return {
    settled: false,
    elapsedMs: input.elapsedMs,
    ...(sample.loading ? { loading: true as const } : {}),
    ...(sample.inflight > 0 ? { inflightRequests: sample.inflight } : {}),
    ...(networkQuiet && state ? { domChangedMsAgo: state.quietMs } : {}),
    ...input.network.watchedField(),
  };
}

/** The page's latest DOM report; one probe in flight at a time, so a busy page is not flooded. */
class PageDomProbe {
  private state: PageDomState | null = null;
  private probing = false;
  private generation = 0;

  public constructor(private readonly page: SettlePage) {}

  public current(): PageDomState | null {
    return this.state;
  }

  public reset(): void {
    this.state = null;
    this.generation += 1;
  }

  public poll(): void {
    if (this.probing) return;
    this.probing = true;
    void this.probe(this.generation);
  }

  private async probe(generation: number): Promise<void> {
    let state: PageDomState | null = null;
    try {
      state = readDomState(await this.page.executeJavaScript(SETTLE_PAGE_SCRIPT));
    } catch {
      // A page that went away mid-probe reports nothing; the next probe asks the new one.
    } finally {
      this.probing = false;
    }
    // A report started before a navigation or load describes the old document.
    if (generation === this.generation) this.state = state;
  }
}

function readDomState(value: unknown): PageDomState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.quietMs !== "number" || typeof record.readyState !== "string") {
    return null;
  }
  return { quietMs: record.quietMs, readyState: record.readyState };
}

/**
 * Installs one MutationObserver per document the first time it runs (childList, attributes, and
 * text, over the document, its same-origin frames, and open shadow roots), and reports how long
 * ago anything changed. The observer lives on the window under a symbol, so it ends with the
 * document; a new document starts a new observer and a new quiet window.
 */
export const SETTLE_PAGE_SCRIPT = String.raw`(() => {
  const key = Symbol.for('paseo.browser-automation.settle');
  let watch = window[key];
  if (!watch || !(watch.observed instanceof WeakSet)) {
    watch = {
      lastChange: performance.now(),
      observed: new WeakSet(),
      observer: null,
      observe: null,
    };
    const observeShadowRoots = (root, budget) => {
      const stack = [root];
      while (stack.length > 0 && budget > 0) {
        const node = stack.pop();
        budget -= 1;
        if (node.shadowRoot) {
          watch.observe(node.shadowRoot);
          stack.push(...node.shadowRoot.children);
        }
        stack.push(...node.children);
      }
    };
    watch.observe = (root) => {
      if (!root || watch.observed.has(root)) return;
      watch.observed.add(root);
      try {
        watch.observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {}
    };
    watch.observer = new MutationObserver((records) => {
      watch.lastChange = performance.now();
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) observeShadowRoots(node, 2000);
        }
      }
    });
    Object.defineProperty(window, key, { configurable: true, enumerable: false, value: watch });
    watch.observe(document);
    if (document.documentElement) observeShadowRoots(document.documentElement, 20000);
  }
  for (const frame of document.querySelectorAll('iframe, frame')) {
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch {}
    if (doc && doc.defaultView && !watch.observed.has(doc)) {
      watch.observe(doc);
      watch.lastChange = performance.now();
    }
  }
  return {
    quietMs: Math.max(0, Math.round(performance.now() - watch.lastChange)),
    readyState: document.readyState,
  };
})()`;

async function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
