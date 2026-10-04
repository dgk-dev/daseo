// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import type {
  BrowserAutomationCommand,
  BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { InflightRequestTracker, NetworkCaptureControl } from "./network-capture.js";
import { capReadContent } from "./read.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import { executeAutomationCommand, type BrowserRegistry, type TabContents } from "./service.js";

// Commands whose page scripts do the work (browser_wait selector/script/load,
// browser_read), run through the service against jsdom's document.

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "workspace-a";

class JsdomTab implements TabContents {
  public readonly id = 1;
  public loading = false;
  public inflight = 0;
  public trackerReleased = false;

  public getURL(): string {
    return window.location.href;
  }
  public getTitle(): string {
    return document.title;
  }
  public canGoBack(): boolean {
    return false;
  }
  public canGoForward(): boolean {
    return false;
  }
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
  public async insertText(): Promise<void> {}
  public async loadURL(): Promise<void> {}
  public goBack(): void {}
  public goForward(): void {}
  public reload(): void {}
  public async capturePage(): Promise<never> {
    throw new Error("no capture in jsdom");
  }
  public invalidate(): void {}
  public withFrameProduction<T>(capture: () => Promise<T>): Promise<T> {
    return capture();
  }
  public sendInputEvent(): void {}
  public getNetworkCapture(): NetworkCaptureControl {
    return {
      capturing: false,
      start: async () => {},
      stop: async () => {},
      list: async () => ({
        entries: [],
        cursor: 0,
        hasMore: false,
        pendingCount: 0,
        droppedCount: 0,
      }),
      trackInflightRequests: async (): Promise<InflightRequestTracker> => ({
        inflight: () => this.inflight,
        lost: () => false,
        release: async () => {
          this.trackerReleased = true;
        },
      }),
    };
  }
}

function registryFor(tab: TabContents): BrowserRegistry {
  return {
    listRegisteredBrowserIds: () => [BROWSER_ID],
    listRegisteredBrowserIdsForWorkspace: () => [BROWSER_ID],
    getTabContents: () => tab,
    getBrowserWorkspaceId: () => WORKSPACE_ID,
    getWorkspaceActiveBrowserId: () => BROWSER_ID,
    isBrowserInputFocused: () => false,
  };
}

async function execute(
  tab: TabContents,
  command: BrowserAutomationCommand,
  snapshotEngine = new BrowserSnapshotEngine(),
) {
  const request: BrowserAutomationExecuteRequest = {
    type: "browser.automation.execute.request",
    requestId: `req-${command.command}`,
    workspaceId: WORKSPACE_ID,
    command,
  };
  return executeAutomationCommand(request, registryFor(tab), { snapshotEngine });
}

async function wait(
  tab: TabContents,
  args: Omit<Extract<BrowserAutomationCommand, { command: "wait" }>["args"], "browserId">,
) {
  const request: BrowserAutomationExecuteRequest = {
    type: "browser.automation.execute.request",
    requestId: "req-wait",
    workspaceId: WORKSPACE_ID,
    command: { command: "wait", args: { browserId: BROWSER_ID, ...args } },
  };
  return executeAutomationCommand(request, registryFor(tab));
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).appReady;
});

describe("browser_wait selector", () => {
  test("matches once the element is attached, visible or not", async () => {
    const tab = new JsdomTab();
    setTimeout(() => {
      document.body.innerHTML = '<div id="results" style="display:none"></div>';
    }, 60);

    await expect(wait(tab, { selector: "#results", timeoutMs: 2_000 })).resolves.toEqual({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "selector" },
    });
  });

  test("finds elements inside open shadow roots", async () => {
    const tab = new JsdomTab();
    const host = document.createElement("x-card");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = '<button class="buy">Buy</button>';

    await expect(wait(tab, { selector: "button.buy", timeoutMs: 500 })).resolves.toMatchObject({
      ok: true,
      result: { matched: "selector" },
    });
  });

  test("fails at once on an invalid selector", async () => {
    const tab = new JsdomTab();
    const startedAt = Date.now();

    await expect(wait(tab, { selector: "div[", timeoutMs: 5_000 })).resolves.toEqual({
      requestId: "req-wait",
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: "Invalid CSS selector: div[",
        retryable: false,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("times out naming the selector", async () => {
    const tab = new JsdomTab();

    await expect(wait(tab, { selector: "#never", timeoutMs: 100 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Timed out waiting for browser selector: #never",
        retryable: true,
      },
    });
  });
});

describe("browser_wait script", () => {
  test("polls the expression until it is truthy", async () => {
    const tab = new JsdomTab();
    setTimeout(() => {
      (window as unknown as Record<string, unknown>).appReady = true;
    }, 60);

    await expect(
      wait(tab, { script: "window.appReady === true", timeoutMs: 2_000 }),
    ).resolves.toMatchObject({ ok: true, result: { matched: "script" } });
  });

  test("calls a function and awaits its promise", async () => {
    const tab = new JsdomTab();
    document.body.innerHTML = "<p>3 items</p>";

    await expect(
      wait(tab, {
        script: "async () => document.body.textContent.includes('3 items')",
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ ok: true, result: { matched: "script" } });
  });

  test("fails at once when the expression throws instead of timing out", async () => {
    const tab = new JsdomTab();
    const startedAt = Date.now();

    await expect(
      wait(tab, { script: "window.missingObject.ready", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: expect.stringMatching(/^browser_wait script threw: .*ready/),
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("accepts await in the expression", async () => {
    const tab = new JsdomTab();

    await expect(
      wait(tab, { script: "await Promise.resolve(true)", timeoutMs: 500 }),
    ).resolves.toMatchObject({ ok: true, result: { matched: "script" } });
  });

  test("names a syntax error without running anything in the page", async () => {
    const tab = new JsdomTab();

    await expect(
      wait(tab, { script: "window.ready ===", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_unknown_error",
        message: expect.stringMatching(/^browser_wait script has a syntax error: /),
      },
    });
  });

  test("a promise that never settles ends at the wait's deadline", async () => {
    const tab = new JsdomTab();

    await expect(
      wait(tab, { script: "new Promise(() => {})", timeoutMs: 100 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_timeout" } });
  });
});

describe("browser_wait load", () => {
  test("load matches when the tab is not loading", async () => {
    const tab = new JsdomTab();

    await expect(wait(tab, { load: "load", timeoutMs: 500 })).resolves.toMatchObject({
      ok: true,
      result: { matched: "load" },
    });
  });

  test("load times out while the tab keeps loading", async () => {
    const tab = new JsdomTab();
    tab.loading = true;

    await expect(wait(tab, { load: "load", timeoutMs: 100 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Timed out waiting for the page to finish loading.",
      },
    });
  });

  test("networkidle waits for 500ms with no request in flight", async () => {
    const tab = new JsdomTab();
    tab.inflight = 2;
    setTimeout(() => {
      tab.inflight = 0;
    }, 100);
    const startedAt = Date.now();

    await expect(wait(tab, { load: "networkidle", timeoutMs: 3_000 })).resolves.toMatchObject({
      ok: true,
      result: { matched: "load" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(tab.trackerReleased).toBe(true);
  });

  test("networkidle times out naming the requests still in flight", async () => {
    const tab = new JsdomTab();
    tab.inflight = 1;

    await expect(wait(tab, { load: "networkidle", timeoutMs: 200 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "browser_timeout",
        message: expect.stringContaining("1 request is still in flight"),
      },
    });
    expect(tab.trackerReleased).toBe(true);
  });
});

const PRODUCT_HEAD = `<title>HDEX Tee</title>
<meta property="og:title" content="HDEX Heavy Tee">
<meta property="og:type" content="product">
<meta property="product:price:amount" content="29900">
<meta property="product:price:currency" content="KRW">
<meta property="product:availability" content="out of stock">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "HDEX Heavy Tee",
  sku: "HT-01",
  brand: { "@type": "Brand", name: "HDEX" },
  offers: {
    "@type": "Offer",
    price: 7000,
    priceCurrency: "KRW",
    availability: "https://schema.org/SoldOut",
  },
})}</script>`;

const LONG_PARAGRAPH =
  "This review covers fit, fabric weight, and how the shirt held up after washing. ".repeat(10);

async function read(
  tab: TabContents,
  args: Partial<
    Omit<Extract<BrowserAutomationCommand, { command: "read" }>["args"], "browserId">
  > = {},
  snapshotEngine?: BrowserSnapshotEngine,
) {
  const result = await execute(
    tab,
    {
      command: "read",
      args: { browserId: BROWSER_ID, scope: "main", links: true, maxChars: 40_000, ...args },
    },
    snapshotEngine,
  );
  if (!result.ok || result.result.command !== "read") {
    throw new Error(`read failed: ${JSON.stringify(result)}`);
  }
  return result.result;
}

describe("browser_read", () => {
  test("puts the product's JSON-LD and meta values before the body", async () => {
    document.head.innerHTML = PRODUCT_HEAD;
    document.body.innerHTML =
      "<main><h1>HDEX Heavy Tee</h1><p>Payment and exchange guide.</p></main>";

    const result = await read(new JsdomTab());

    expect(result.content.split("\n\n")[0]).toBe(
      [
        "Structured data:",
        '- Product: "HDEX Heavy Tee" · 7000 KRW · SoldOut · sku HT-01 · brand HDEX',
        '- og: title "HDEX Heavy Tee" · type product',
        "- product meta: price 29900 KRW · availability out of stock",
      ].join("\n"),
    );
    expect(result.stats.structuredDataFound).toBe(true);
  });

  test("falls back to the whole page when Readability finds no article", async () => {
    document.head.innerHTML = "<title>Shell</title>";
    document.body.innerHTML = `<div id="app"><p>${"Loading the shop. ".repeat(16)}</p></div>`;

    const result = await read(new JsdomTab());

    expect(result.scope).toBe("page");
    expect(result.content).toContain("Loading the shop.");
  });

  test("main reads the article without the page's navigation", async () => {
    document.head.innerHTML = "<title>Review</title>";
    document.body.innerHTML = `<nav><a href="/home">Home</a><a href="/shop">Shop</a></nav>
      <article><h1>Heavy Tee review</h1><p>${LONG_PARAGRAPH}</p>
      <p>See the <a href="/size-guide">size guide</a> first.</p></article>
      <footer>Copyright Example</footer>`;

    const result = await read(new JsdomTab());

    expect(result.scope).toBe("main");
    expect(result.content).toContain(
      "See the [size guide](http://localhost:3000/size-guide) first.",
    );
    expect(result.content).not.toContain("Copyright Example");
    expect(result.stats.links).toBe(1);
  });

  test("page drops page-level landmarks, hidden elements, and scripts but keeps tables and alt text", async () => {
    document.head.innerHTML = "<title>Specs</title>";
    document.body.innerHTML = `<header>Site banner</header><nav>Menu</nav>
      <div id="content">
        <article><header><h2>Specs</h2></header>
        <table><tr><td>Weight</td><td>300 g</td></tr><tr><td>Fabric</td><td>Cotton | jersey</td></tr></table>
        <img src="/tee.png" alt="Front view"><img src="/spacer.gif">
        <p style="display:none">Hidden promo</p><p hidden>Hidden too</p>
        <script>window.tracking = "Script text";</script>
        <ul><li>Machine wash</li><li>Tumble dry low</li></ul></article>
        <aside>Related products</aside>
      </div>
      <footer>Footer links</footer>`;

    const result = await read(new JsdomTab(), { scope: "page" });

    expect(result.scope).toBe("page");
    expect(result.content).toBe(
      [
        "## Specs",
        "| Weight | 300 g |\n| --- | --- |\n| Fabric | Cotton \\| jersey |",
        "![Front view]",
        "- Machine wash\n- Tumble dry low",
      ].join("\n\n"),
    );
  });

  test("links false keeps only the link text", async () => {
    document.head.innerHTML = "<title>Links</title>";
    document.body.innerHTML = '<p>Go to <a href="/next">the next page</a>.</p>';

    const result = await read(new JsdomTab(), { scope: "page", links: false });

    expect(result.content).toBe("Go to the next page.");
    expect(result.stats.links).toBe(0);
  });

  test("includes same-origin iframe content and names cross-origin frames", async () => {
    document.head.innerHTML = "<title>Cart</title>";
    document.body.innerHTML =
      '<p>Your cart</p><iframe id="drawer"></iframe><iframe id="pay" src="https://pay.example/checkout"></iframe>';
    const drawer = document.querySelector("#drawer") as HTMLIFrameElement;
    drawer.contentDocument?.write("<body><p>Coupon applied</p></body>");
    drawer.contentDocument?.close();
    Object.defineProperty(document.querySelector("#pay"), "contentDocument", { get: () => null });

    const result = await read(new JsdomTab(), { scope: "page" });

    expect(result.content).toBe(
      "Your cart\n\nCoupon applied\n\n[iframe: https://pay.example/checkout]",
    );
  });

  test("ref reads one element from the latest snapshot", async () => {
    // The snapshot reads jsdom's empty computed opacity as hidden.
    document.head.innerHTML = "<title>Ref</title><style>* { opacity: 1; }</style>";
    document.body.innerHTML =
      '<p>Outside</p><a href="/detail" style="display:block">Open <b>details</b></a>';
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
    try {
      const engine = new BrowserSnapshotEngine();
      const tab = new JsdomTab();
      const snapshot = await execute(
        tab,
        { command: "snapshot", args: { browserId: BROWSER_ID } },
        engine,
      );
      const ref =
        snapshot.ok && snapshot.result.command === "snapshot"
          ? /\[ref=(@e\d+)\]/.exec(snapshot.result.snapshot)?.[1]
          : undefined;
      if (!ref) throw new Error(`no ref in ${JSON.stringify(snapshot)}`);

      const result = await read(tab, { ref }, engine);

      expect(result.scope).toBe("ref");
      expect(result.content).toBe("[Open **details**](http://localhost:3000/detail)");
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  test("cuts the content at maxChars and reports the full length", async () => {
    document.head.innerHTML = "<title>Long</title>";
    document.body.innerHTML = `<p>${"x".repeat(5_000)}</p>`;

    const result = await read(new JsdomTab(), { scope: "page", maxChars: 1_000 });

    expect(result.truncated).toBe(true);
    expect(result.stats.chars).toBe(5_000);
    expect(result.content).toBe(`${"x".repeat(1_000)}\n\n[truncated]`);
  });

  test("never splits a surrogate pair when cutting", () => {
    expect(capReadContent("ab😀cd", 3)).toEqual({ content: "ab\n\n[truncated]", truncated: true });
  });

  test("leaves nothing on the page's window", async () => {
    document.head.innerHTML = "<title>Globals</title>";
    document.body.innerHTML = "<p>Hello</p>";
    const before = new Set(Object.getOwnPropertyNames(window));

    await read(new JsdomTab(), { scope: "page" });

    const added = Object.getOwnPropertyNames(window).filter((name) => !before.has(name));
    expect(added).toEqual([]);
  });
});
