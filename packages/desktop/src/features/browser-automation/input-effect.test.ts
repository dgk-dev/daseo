import { describe, expect, it } from "vitest";
import {
  describeInputEffect,
  INPUT_EFFECT_WINDOW_MS,
  observeInputEffect,
  type InputEffectPage,
} from "./input-effect.js";

// The page side of the probe runs in jsdom in aria-snapshot-script.test.ts and in Chromium in the
// capture harness click-effect group; these cover how main combines it with host signals.
function scriptedPage(answers: { arm: unknown; wait: () => Promise<unknown> }): InputEffectPage & {
  scripts: string[];
} {
  const scripts: string[] = [];
  return {
    scripts,
    async executeJavaScript(code: string) {
      scripts.push(code);
      if (code.includes("ensureInsertionLog();")) return answers.arm;
      if (code.includes("probe.wait(")) return answers.wait();
      return true;
    },
  };
}

describe("observeInputEffect", () => {
  it("returns the page's effect", async () => {
    const page = scriptedPage({
      arm: true,
      wait: async () => ({ kind: "state", attribute: "aria-expanded", value: "true" }),
    });

    const observed = await observeInputEffect({
      page,
      elementExpression: "document.body",
      signals: {},
      dispatch: async () => true,
    });

    expect(observed).toEqual({
      dispatched: true,
      effect: { kind: "state", attribute: "aria-expanded", value: "true" },
    });
  });

  it("lets a navigation the input started win over a page that never answers", async () => {
    const page = scriptedPage({ arm: true, wait: () => new Promise(() => {}) });
    let navigate: (url: string, sameDocument: boolean) => void = () => {};
    const started = Date.now();

    const observed = await observeInputEffect({
      page,
      elementExpression: "document.body",
      signals: {
        onNavigationStarted: (listener) => {
          navigate = listener;
          return () => {};
        },
      },
      dispatch: async () => {
        navigate("https://example.com/next", false);
        return true;
      },
    });

    expect(observed.effect).toEqual({
      kind: "navigation",
      url: "https://example.com/next",
      sameDocument: false,
    });
    expect(Date.now() - started).toBeLessThan(INPUT_EFFECT_WINDOW_MS);
  });

  it("reports a popup, a page dialog, and unsubscribes afterwards", async () => {
    const page = scriptedPage({ arm: true, wait: () => new Promise(() => {}) });
    let unsubscribed = 0;
    let open: (type: string) => void = () => {};

    const observed = await observeInputEffect({
      page,
      elementExpression: "document.body",
      signals: {
        onPageDialog: (listener) => {
          open = listener;
          return () => {
            unsubscribed += 1;
          };
        },
        onTargetOpened: () => () => {
          unsubscribed += 1;
        },
      },
      dispatch: async () => {
        open("confirm");
        return true;
      },
    });

    expect(observed.effect).toEqual({ kind: "page-dialog", type: "confirm" });
    expect(unsubscribed).toBe(2);
  });

  it("says no change when a page that never answers shows nothing", async () => {
    const page = scriptedPage({ arm: true, wait: () => new Promise(() => {}) });

    const observed = await observeInputEffect({
      page,
      elementExpression: "document.body",
      signals: {},
      windowMs: 10,
      dispatch: async () => true,
    });

    expect(observed.effect).toEqual({ kind: "none" });
  });

  it("still dispatches, without an effect, when the probe cannot be armed", async () => {
    const page = scriptedPage({ arm: false, wait: async () => ({ kind: "none" }) });
    let dispatched = 0;

    const observed = await observeInputEffect({
      page,
      elementExpression: "null",
      signals: {},
      dispatch: async () => {
        dispatched += 1;
        return true;
      },
    });

    expect(dispatched).toBe(1);
    expect(observed).toEqual({ dispatched: true, effect: null });
  });

  it("passes a failed dispatch through", async () => {
    const page = scriptedPage({ arm: true, wait: async () => ({ kind: "none" }) });

    const observed = await observeInputEffect({
      page,
      elementExpression: "document.body",
      signals: {},
      dispatch: async () => false,
    });

    expect(observed).toEqual({ dispatched: false, effect: null });
  });
});

describe("describeInputEffect", () => {
  it("writes one line per effect", () => {
    expect(
      describeInputEffect(
        { kind: "navigation", url: "https://a.test/x", sameDocument: false },
        "click",
      ),
    ).toBe("navigation started to https://a.test/x");
    expect(
      describeInputEffect(
        { kind: "overlay", role: "dialog", name: "Create Passkey", appearing: true },
        "click",
      ),
    ).toBe(
      'a dialog "Create Passkey" appeared and is still fading in (find and snapshot mark it appearing=true)',
    );
    expect(describeInputEffect({ kind: "state", attribute: "disabled", value: "" }, "click")).toBe(
      "disabled was set on the element",
    );
    expect(
      describeInputEffect(
        { kind: "opened", type: "popup_opened", browserId: "b-2", url: "https://a.test/" },
        "click",
      ),
    ).toBe("opened popup b-2 at https://a.test/");
    expect(describeInputEffect({ kind: "focus" }, "key")).toBe(
      "no change seen within 500 ms, only focus moved to the element; the key may not have activated it",
    );
    expect(describeInputEffect({ kind: "none" }, "click")).toBe("no change seen within 500 ms");
  });
});
