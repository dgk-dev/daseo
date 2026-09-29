// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";
import { dispatchFocusIsolatedClick } from "./focus-isolated-input.js";

// Runs the real injected snapshot script against a DOM and renders it, so the
// capture and the renderer are tested together. jsdom has no layout: every
// element gets a 10x10 box, and the stylesheet supplies what jsdom's computed
// style leaves empty: inline display for inline elements, and an opacity (the
// script reads an empty opacity as 0, i.e. hidden).
const INLINE_STYLE = "* { opacity: 1; } span, b, i, em, strong, a, label { display: inline; }";

function page(): SnapshotPage {
  return {
    getURL: () => window.location.href,
    // Indirect eval runs the script in the global scope, where jsdom's window lives.
    executeJavaScript: async (code: string) => (0, eval)(code),
  };
}

async function snapshotOf(html: string, afterRender?: () => void): Promise<string> {
  document.head.innerHTML = `<title>Fixture</title><style>${INLINE_STYLE}</style>`;
  document.body.innerHTML = html;
  afterRender?.();
  const result = await new BrowserSnapshotEngine().snapshot({
    browserId: "browser-1",
    page: page(),
  });
  return result.snapshot;
}

describe("ARIA snapshot script", () => {
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    document.body.innerHTML = "";
  });

  it("joins inline runs with a space only where the page has whitespace", async () => {
    const snapshot = await snapshotOf(
      "<p><span>T</span><span>h</span><span>i</span><span>s</span> <b>is</b> bold</p>",
    );
    expect(snapshot).toBe(['- document "Fixture"', '  - text: "This is bold"'].join("\n"));
  });

  it("keeps whitespace written inside the inline element", async () => {
    const snapshot = await snapshotOf("<p>Price:<span> $5</span><b>.00 </b>today</p>");
    expect(snapshot).toBe(['- document "Fixture"', '  - text: "Price: $5.00 today"'].join("\n"));
  });

  it("keeps block elements on their own lines", async () => {
    const snapshot = await snapshotOf("<div><div>Alpha item</div><div>Beta item</div></div>");
    expect(snapshot).toBe(
      ['- document "Fixture"', '  - text: "Alpha item"', '  - text: "Beta item"'].join("\n"),
    );
  });

  it("marks the focused element and disabled controls", async () => {
    const snapshot = await snapshotOf(
      '<input aria-label="Name"><button disabled>Save</button><fieldset disabled><button>Send</button></fieldset>',
      () => (document.querySelector("input") as HTMLInputElement).focus(),
    );
    expect(snapshot).toContain('- textbox "Name" [focused=true ref=');
    // Disabled controls stay without a ref; the attribute says why.
    expect(snapshot).toContain('- button "Save" [disabled=true]\n');
    expect(snapshot).toMatch(/- button "Send" \[disabled=true\]$/m);
  });

  it("marks the focused element inside an open shadow root", async () => {
    const snapshot = await snapshotOf("<div id=host></div>", () => {
      const host = document.getElementById("host") as HTMLElement;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<input aria-label="Inner">';
      (root.querySelector("input") as HTMLInputElement).focus();
    });
    expect(snapshot).toContain('- textbox "Inner" [focused=true ref=');
  });

  it("reports no focus when nothing is focused", async () => {
    const snapshot = await snapshotOf('<input aria-label="Name">');
    expect(snapshot).not.toContain("focused=");
  });
});

// A same-origin iframe is a separate realm in jsdom as in Chromium: its
// elements fail `instanceof` against the top window's classes, which is the
// mistake these tests guard against.
describe("ARIA snapshot script with iframes", () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const fakeRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;

  beforeEach(() => {
    Element.prototype.getBoundingClientRect = fakeRect;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    document.body.innerHTML = "";
  });

  function mountFrame(innerHtml: string): { frame: HTMLIFrameElement; frameWindow: Window } {
    document.head.innerHTML = `<title>Shop</title><style>${INLINE_STYLE}</style>`;
    document.body.innerHTML = '<h1>Cart page</h1><iframe title="Cart"></iframe>';
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    const frameWindow = frame.contentWindow as Window & typeof globalThis;
    const frameDocument = frame.contentDocument as Document;
    frameWindow.Element.prototype.getBoundingClientRect = fakeRect;
    // jsdom has no layout, so no scrollIntoView either.
    frameWindow.Element.prototype.scrollIntoView = () => undefined;
    frameDocument.head.innerHTML = `<style>${INLINE_STYLE}</style>`;
    frameDocument.body.innerHTML = innerHtml;
    return { frame, frameWindow };
  }

  async function snapshotWithEngine(engine: BrowserSnapshotEngine): Promise<string> {
    return (await engine.snapshot({ browserId: "browser-1", page: page() })).snapshot;
  }

  function refFor(snapshot: string, line: string): string {
    const ref = new RegExp(
      `${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(@e\\d+)\\]`,
    ).exec(snapshot)?.[1];
    if (!ref) throw new Error(`no ref for ${line} in\n${snapshot}`);
    return ref;
  }

  it("lists same-origin iframe content under the iframe node with refs", async () => {
    mountFrame('<p>Your cart</p><input aria-label="Coupon"><button>Checkout</button>');
    const snapshot = await snapshotWithEngine(new BrowserSnapshotEngine());

    expect(snapshot).toMatch(
      /^- document "Shop"\n {2}- heading "Cart page" \[level=1\]\n {2}- iframe "Cart"\n {4}- text: "Your cart"\n {4}- textbox "Coupon" \[ref=@e\d+\]\n {4}- button "Checkout" \[ref=@e\d+\]$/,
    );
  });

  it("fills and clicks refs inside the frame with the frame's own events", async () => {
    const { frameWindow } = mountFrame('<input aria-label="Coupon"><button>Checkout</button>');
    const frameDocument = frameWindow.document;
    const seen: string[] = [];
    const input = frameDocument.querySelector("input") as HTMLInputElement;
    input.addEventListener("input", (event) => {
      seen.push(`input:${event instanceof (frameWindow as typeof globalThis).Event}`);
    });
    (frameDocument.querySelector("button") as HTMLButtonElement).addEventListener(
      "click",
      (event) => {
        seen.push(`click:${event instanceof (frameWindow as typeof globalThis).MouseEvent}`);
      },
    );
    const engine = new BrowserSnapshotEngine();
    const snapshot = await snapshotWithEngine(engine);

    const fill = await engine.fill({
      browserId: "browser-1",
      page: page(),
      ref: refFor(snapshot, 'textbox "Coupon"'),
      value: "SAVE10",
    });
    const expression = engine.runtimeElementExpression({
      browserId: "browser-1",
      ref: refFor(snapshot, 'button "Checkout"'),
    });
    if (typeof expression !== "string") throw new Error("checkout ref did not resolve");
    const clicked = await dispatchFocusIsolatedClick(page(), expression, { x: 5, y: 5 });

    expect(fill).toEqual({ ok: true });
    expect(input.value).toBe("SAVE10");
    expect(clicked).toBe(true);
    expect(seen).toEqual(["input:true", "click:true"]);
  });

  it("marks the focused element inside a same-origin frame", async () => {
    const { frame } = mountFrame('<input aria-label="Coupon">');
    frame.focus();
    ((frame.contentDocument as Document).querySelector("input") as HTMLInputElement).focus();

    expect(await snapshotWithEngine(new BrowserSnapshotEngine())).toContain(
      '- textbox "Coupon" [focused=true ref=',
    );
  });

  it("stales refs from a removed frame", async () => {
    const { frame } = mountFrame("<button>Checkout</button>");
    const engine = new BrowserSnapshotEngine();
    const ref = refFor(await snapshotWithEngine(engine), 'button "Checkout"');
    frame.remove();

    expect(await engine.fill({ browserId: "browser-1", page: page(), ref, value: "x" })).toEqual({
      ok: false,
      reason: "stale_ref",
    });
  });

  it("keeps a cross-origin frame as one node with its src", async () => {
    document.head.innerHTML = `<title>Shop</title><style>${INLINE_STYLE}</style>`;
    document.body.innerHTML =
      '<iframe title="Payment" src="https://pay.example/checkout"></iframe><button>Back</button>';
    // Chromium returns null for a document the page may not access.
    Object.defineProperty(document.querySelector("iframe"), "contentDocument", { get: () => null });

    expect(await snapshotWithEngine(new BrowserSnapshotEngine())).toMatch(
      /^- document "Shop"\n {2}- iframe "Payment" \[cross-origin=true src=https:\/\/pay\.example\/checkout\]\n {2}- button "Back" \[ref=@e\d+\]$/,
    );
  });

  it("counts frame nodes against the global node cap", async () => {
    const rows = Array.from({ length: 1600 }, (_, index) => `<p>row ${index}</p>`).join("");
    mountFrame(rows);
    const result = await new BrowserSnapshotEngine().snapshot({
      browserId: "browser-1",
      page: page(),
    });

    expect(result.truncated).toBe(true);
    expect(result.stats.nodeCount).toBe(1500);
    expect(result.snapshot).toContain('- text: "Snapshot truncated."');
  });
});
