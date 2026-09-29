// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";

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
