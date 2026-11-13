// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";
import type { AriaFindQuery } from "./aria-snapshot-script.js";
import { dispatchFocusIsolatedClick } from "./focus-isolated-input.js";
import { observeInputEffect } from "./input-effect.js";

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

describe("browser_find script", () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const query = (input: Partial<AriaFindQuery>): AriaFindQuery => ({
    role: null,
    name: null,
    exact: false,
    pattern: null,
    limit: 10,
    ...input,
  });

  beforeEach(() => {
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
    // jsdom has no layout, so no scrolling either.
    Element.prototype.scrollIntoView = () => undefined;
    document.head.innerHTML = `<title>Shop</title><style>${INLINE_STYLE}</style>`;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    document.body.innerHTML = "";
    delete (window as unknown as Record<symbol, unknown>)[Symbol.for("paseo.browser-automation")];
  });

  it("returns a ref that clicks the matched button", async () => {
    document.body.innerHTML =
      '<nav aria-label="상단 메뉴"><button>장바구니</button></nav><main><button id="add">장바구니 담기</button></main>';
    const clicks: string[] = [];
    document.querySelector("#add")?.addEventListener("click", () => clicks.push("add"));
    const engine = new BrowserSnapshotEngine();

    const found = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "button", name: "장바구니 담기" }),
    });

    expect(found).toEqual({
      total: 1,
      matches: [
        {
          ref: expect.stringMatching(/^@e\d+$/),
          role: "button",
          name: "장바구니 담기",
          states: [],
          landmark: "main",
        },
      ],
    });
    const ref = found.matches[0]?.ref ?? "";
    const expression = engine.runtimeElementExpression({ browserId: "browser-1", ref });
    if (typeof expression !== "string") throw new Error("find ref did not resolve");
    expect(await dispatchFocusIsolatedClick(page(), expression, { x: 5, y: 5 })).toBe(true);
    expect(clicks).toEqual(["add"]);
  });

  it("matches names as a case-insensitive substring and names the landmark", async () => {
    document.body.innerHTML =
      '<nav aria-label="상단 메뉴"><button>장바구니</button></nav><main><button>장바구니 담기</button><button>Buy</button></main>';

    const found = await new BrowserSnapshotEngine().find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "button", name: "장바구니" }),
    });

    expect(found.total).toBe(2);
    expect(found.matches.map((match) => [match.name, match.landmark])).toEqual([
      ["장바구니", 'navigation "상단 메뉴"'],
      ["장바구니 담기", "main"],
    ]);
  });

  it("gives the same ref a snapshot shows and keeps the snapshot's refs working", async () => {
    document.body.innerHTML = "<button>Save</button><a href='/next'>Next</a>";
    const engine = new BrowserSnapshotEngine();
    const snapshot = (await engine.snapshot({ browserId: "browser-1", page: page() })).snapshot;
    const snapshotRef = /button "Save" \[ref=(@e\d+)\]/.exec(snapshot)?.[1];
    const linkRef = /link "Next" \[ref=(@e\d+)\]/.exec(snapshot)?.[1] ?? "";

    const found = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ name: "save" }),
    });

    expect(found.matches[0]?.ref).toBe(snapshotRef);
    const linkExpression = engine.runtimeElementExpression({
      browserId: "browser-1",
      ref: linkRef,
    });
    if (typeof linkExpression !== "string") throw new Error("snapshot ref stopped resolving");
    expect((0, eval)(linkExpression)).toBe(document.querySelector("a"));
  });

  it("returns non-actionable matches without a ref, with their state and text", async () => {
    document.body.innerHTML =
      '<h2>Reviews</h2><p hidden><button>Hidden buy</button></p><button disabled>Buy</button><div style="display:none"><h2>Old reviews</h2></div>';

    const engine = new BrowserSnapshotEngine();
    const headings = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "heading" }),
    });
    const buttons = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "button" }),
    });

    expect(headings).toEqual({
      total: 1,
      matches: [{ role: "heading", name: "Reviews", states: ["level=2"] }],
    });
    expect(buttons).toEqual({
      total: 1,
      matches: [{ role: "button", name: "Buy", states: ["disabled=true"] }],
    });
  });

  it("supports exact names, regular expressions, and the limit", async () => {
    document.body.innerHTML =
      "<button>Add</button><button>Add more</button><button>Remove</button>";
    const engine = new BrowserSnapshotEngine();

    const exact = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ name: "Add", exact: true }),
    });
    const pattern = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ pattern: { source: "^(add|remove)$", flags: "i" } }),
    });
    const limited = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "button", limit: 1 }),
    });

    expect(exact.matches.map((match) => match.name)).toEqual(["Add"]);
    expect(pattern.matches.map((match) => match.name)).toEqual(["Add", "Remove"]);
    expect(limited.total).toBe(3);
    expect(limited.matches.map((match) => match.name)).toEqual(["Add"]);
  });
});

// Daseo delta 100.
describe("appearing elements, background click order, and the input probe", () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const query = (input: Partial<AriaFindQuery>): AriaFindQuery => ({
    role: null,
    name: null,
    exact: false,
    pattern: null,
    limit: 10,
    ...input,
  });
  const nextMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
    Element.prototype.scrollIntoView = () => undefined;
    document.head.innerHTML = `<title>Fixture</title><style>${INLINE_STYLE}</style>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Element.prototype.getBoundingClientRect = originalRect;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    document.body.innerHTML = "";
    for (const key of [
      "paseo.browser-automation",
      "paseo.browser-automation.insertions",
      "paseo.browser-automation.input-probe",
    ]) {
      delete (window as unknown as Record<symbol, unknown>)[Symbol.for(key)];
    }
  });

  function mountModal(style: string): void {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Create Passkey");
    modal.setAttribute("style", style);
    modal.innerHTML = "<button>Continue</button>";
    document.body.append(modal);
  }

  it("shows a just-inserted modal at opacity 0 with a transition as appearing", async () => {
    document.body.innerHTML = "<button>Add</button>";
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page: page() });
    mountModal("opacity: 0; transition-duration: 0.4s");
    await nextMicrotasks();

    const found = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "dialog" }),
    });
    const { snapshot } = await engine.snapshot({ browserId: "browser-1", page: page() });

    expect(found.matches).toEqual([
      expect.objectContaining({
        role: "dialog",
        name: "Create Passkey",
        states: ["appearing=true"],
      }),
    ]);
    expect(snapshot).toContain('- dialog "Create Passkey" [appearing=true]');
    expect(snapshot).toMatch(/- button "Continue" \[ref=@e\d+\]/);
  });

  it("keeps an element held at opacity 0 hidden", async () => {
    document.body.innerHTML = "<button>Add</button>";
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page: page() });
    mountModal("opacity: 0");
    await nextMicrotasks();

    const found = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "dialog" }),
    });

    expect(found.total).toBe(0);
  });

  it("stops calling an opacity-0 element appearing a second after it was inserted", async () => {
    document.body.innerHTML = "<button>Add</button>";
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page: page() });
    mountModal("opacity: 0; transition-duration: 0.4s");
    await nextMicrotasks();
    const later = performance.now() + 1_500;
    vi.spyOn(performance, "now").mockReturnValue(later);

    const found = await engine.find({
      browserId: "browser-1",
      page: page(),
      query: query({ role: "dialog" }),
    });

    expect(found.total).toBe(0);
  });

  it("presses with buttons 1 and moves focus at mousedown, not before", async () => {
    document.body.innerHTML = '<input aria-label="Before"><button id="go">Go</button>';
    const before = document.querySelector("input") as HTMLInputElement;
    before.focus();
    const go = document.querySelector("#go") as HTMLButtonElement;
    const seen: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      go.addEventListener(type, (event) => {
        seen.push(`${type}:${(event as MouseEvent).buttons}:${document.activeElement === go}`);
      });
    }
    const engine = new BrowserSnapshotEngine();
    const { snapshot } = await engine.snapshot({ browserId: "browser-1", page: page() });
    const ref = /button "Go" \[ref=(@e\d+)\]/.exec(snapshot)?.[1] ?? "";
    const expression = engine.runtimeElementExpression({ browserId: "browser-1", ref });
    if (typeof expression !== "string") throw new Error("ref did not resolve");

    expect(await dispatchFocusIsolatedClick(page(), expression, { x: 5, y: 5 })).toBe(true);
    // jsdom has no PointerEvent, so only the mouse events fire here; the capture harness
    // click-effect group checks the pointer events in Chromium.
    expect(seen).toEqual(["mousedown:1:false", "mouseup:0:true", "click:0:true"]);
  });

  it("leaves focus where it was when the page cancels mousedown", async () => {
    document.body.innerHTML = '<input aria-label="Before"><button id="go">Go</button>';
    const before = document.querySelector("input") as HTMLInputElement;
    before.focus();
    document.querySelector("#go")?.addEventListener("mousedown", (event) => event.preventDefault());
    const engine = new BrowserSnapshotEngine();
    const { snapshot } = await engine.snapshot({ browserId: "browser-1", page: page() });
    const ref = /button "Go" \[ref=(@e\d+)\]/.exec(snapshot)?.[1] ?? "";
    const expression = engine.runtimeElementExpression({ browserId: "browser-1", ref });
    if (typeof expression !== "string") throw new Error("ref did not resolve");

    await dispatchFocusIsolatedClick(page(), expression, { x: 5, y: 5 });

    expect(document.activeElement).toBe(before);
  });

  function expand(button: HTMLButtonElement): void {
    button.setAttribute("aria-expanded", "true");
  }
  function openFadingModal(): void {
    mountModal("opacity: 0; transition-duration: 0.4s");
  }
  function writeSaved(): void {
    (document.querySelector("#out") as HTMLElement).textContent = "Saved";
  }
  function cancelSubmit(event: Event): void {
    event.preventDefault();
  }
  function wrapInCancellingForm(button: HTMLButtonElement): void {
    const form = document.createElement("form");
    button.replaceWith(form);
    form.append(button);
    form.addEventListener("submit", cancelSubmit);
  }

  // onClick runs as the button's click handler; setup prepares the page before the snapshot.
  async function probedClick(
    onClick: ((button: HTMLButtonElement) => void) | null,
    setup?: (button: HTMLButtonElement) => void,
  ) {
    document.body.innerHTML =
      '<div><div><section><button id="go">Go</button><p id="out"></p></section></div></div>';
    const button = document.querySelector("#go") as HTMLButtonElement;
    if (onClick) button.addEventListener("click", () => onClick(button));
    setup?.(button);
    const engine = new BrowserSnapshotEngine();
    const { snapshot } = await engine.snapshot({ browserId: "browser-1", page: page() });
    const ref = /button "Go" \[ref=(@e\d+)\]/.exec(snapshot)?.[1] ?? "";
    const expression = engine.runtimeElementExpression({ browserId: "browser-1", ref });
    if (typeof expression !== "string") throw new Error("ref did not resolve");
    return observeInputEffect({
      page: page(),
      elementExpression: expression,
      signals: {},
      windowMs: 50,
      dispatch: () => dispatchFocusIsolatedClick(page(), expression, { x: 5, y: 5 }),
    });
  }

  it("names a state change on the element at once", async () => {
    const observed = await probedClick(expand);
    expect(observed.effect).toEqual({ kind: "state", attribute: "aria-expanded", value: "true" });
  });

  it("names a dialog the click appended, still fading in", async () => {
    const observed = await probedClick(openFadingModal);
    expect(observed.effect).toEqual({
      kind: "overlay",
      role: "dialog",
      name: "Create Passkey",
      appearing: true,
    });
  });

  it("names text that changed near the element", async () => {
    const observed = await probedClick(writeSaved);
    expect(observed.effect).toEqual({ kind: "text" });
  });

  it("says only focus moved when the click changed nothing else", async () => {
    const observed = await probedClick(null);
    expect(observed.effect).toEqual({ kind: "focus" });
  });

  it("says the page cancelled a form submit", async () => {
    const observed = await probedClick(null, wrapInCancellingForm);
    expect(observed.effect).toEqual({ kind: "submit-cancelled" });
  });
});
