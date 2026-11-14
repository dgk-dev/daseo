import { describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";

class SnapshotFixture implements SnapshotPage {
  public currentUrl = "https://example.com/form";
  public actionResult: unknown = { ok: true };
  public alreadyTruncated = false;
  public snapshotNodes: unknown[] = [
    {
      kind: "role",
      role: "heading",
      name: "Settings",
      tagName: "h1",
      attributes: ["level=1"],
      children: [],
    },
    { kind: "text", text: "Connected as Maya" },
    {
      kind: "role",
      role: "button",
      name: "Save changes",
      tagName: "button",
      attributes: [],
      ref: "@e1",
      fingerprint: {
        role: "button",
        name: "Save changes",
        tagName: "button",
        type: "",
        ariaLabel: "",
      },
      children: [],
    },
  ];

  public getURL(): string {
    return this.currentUrl;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    if (code.includes("__PASEO_ARIA_SNAPSHOT__")) {
      return JSON.stringify({
        marker: "__PASEO_ARIA_SNAPSHOT__",
        root: {
          kind: "role",
          role: "document",
          name: "Fixture",
          tagName: "document",
          attributes: [],
          children: this.snapshotNodes,
        },
        refs: [
          {
            ref: "@e1",
            fingerprint: {
              role: "button",
              name: "Save changes",
              tagName: "button",
              type: "",
              ariaLabel: "",
            },
          },
        ],
        truncated: this.alreadyTruncated,
        stats: { nodeCount: 4, refCount: 1, textLength: 0, iframeCount: 0, maxDepth: 1 },
      });
    }
    return this.actionResult;
  }
}

describe("BrowserSnapshotEngine", () => {
  function navWithSaveButton(): unknown[] {
    return [
      {
        kind: "role",
        role: "navigation",
        name: "Main",
        tagName: "nav",
        attributes: [],
        children: [
          {
            kind: "role",
            role: "generic",
            tagName: "div",
            attributes: [],
            children: [{ kind: "text", text: "Menu" }],
          },
          {
            kind: "role",
            role: "button",
            name: "Save changes",
            tagName: "button",
            attributes: [],
            ref: "@e1",
            fingerprint: {
              role: "button",
              name: "Save changes",
              tagName: "button",
              type: "",
              ariaLabel: "",
            },
            children: [],
          },
        ],
      },
      { kind: "text", text: "Footer text" },
    ];
  }

  it("renders only the subtree of a scope ref", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = navWithSaveButton();
    const engine = new BrowserSnapshotEngine();

    const result = await engine.snapshotScoped({ browserId: "b", page, scopeRef: "@e1" });

    expect("snapshot" in result ? result.snapshot : result).toBe(
      '- button "Save changes" [ref=@e1]',
    );
  });

  it("reports a scope ref that is no longer on the page as stale", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    expect(await engine.snapshotScoped({ browserId: "b", page, scopeRef: "@e9" })).toEqual({
      ok: false,
      reason: "stale_ref",
    });
  });

  it("keeps refs and the named containers around them when interactive", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = navWithSaveButton();
    const engine = new BrowserSnapshotEngine();

    const result = await engine.snapshotScoped({ browserId: "b", page, interactiveOnly: true });

    expect("snapshot" in result ? result.snapshot : result).toBe(
      [
        '- document "Fixture"',
        '  - navigation "Main"',
        '    - button "Save changes" [ref=@e1]',
      ].join("\n"),
    );
  });

  it("keeps text from separate block elements on separate lines", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [
      { kind: "group", block: true, children: [{ kind: "text", text: "Alpha item" }] },
      { kind: "group", block: true, children: [{ kind: "text", text: "Beta item" }] },
      {
        kind: "group",
        block: true,
        children: [
          { kind: "text", text: "Hello", trailingSpace: true },
          { kind: "group", children: [{ kind: "text", text: "bold" }] },
          { kind: "text", text: "world", leadingSpace: true },
        ],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const result = await engine.snapshot({ browserId: "browser-1", page });

    expect(result.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - text: "Alpha item"',
        '  - text: "Beta item"',
        '  - text: "Hello bold world"',
      ].join("\n"),
    );
  });

  it("drops text that repeats a node name and merges adjacent text runs", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [
      {
        kind: "role",
        role: "button",
        name: "Save changes",
        tagName: "button",
        attributes: [],
        ref: "@e1",
        fingerprint: {
          role: "button",
          name: "Save changes",
          tagName: "button",
          type: "",
          ariaLabel: "",
        },
        children: [
          { kind: "group", children: [{ kind: "text", text: "Save" }] },
          { kind: "text", text: "changes", leadingSpace: true },
        ],
      },
      {
        kind: "role",
        role: "listitem",
        name: "",
        tagName: "li",
        attributes: [],
        children: [
          { kind: "text", text: "Price:", trailingSpace: true },
          { kind: "group", children: [{ kind: "text", text: "$5" }] },
        ],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const result = await engine.snapshot({ browserId: "browser-1", page });

    expect(result.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - button "Save changes" [ref=@e1]',
        "  - listitem",
        '    - text: "Price: $5"',
      ].join("\n"),
    );
  });

  it("renders a hierarchical ARIA YAML snapshot with static text and actionable refs", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    await expect(engine.snapshot({ browserId: "browser-1", page })).resolves.toEqual({
      format: "aria-yaml",
      snapshot: [
        '- document "Fixture"',
        '  - heading "Settings" [level=1]',
        '  - text: "Connected as Maya"',
        '  - button "Save changes" [ref=@e1]',
      ].join("\n"),
      truncated: false,
      stats: { nodeCount: 4, refCount: 1, textLength: 119, iframeCount: 0, maxDepth: 1 },
    });
  });

  it("builds a runtime ref expression with the snapshot fingerprint", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.currentUrl = "https://example.com/form?panel=advanced";

    const target = engine.resolveRefTarget({ browserId: "browser-1", ref: "@e1", page });
    expect("ok" in target ? target : target.elementExpression).toContain('"name":"Save changes"');
  });

  it("treats missing host-side ref metadata as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    expect(engine.resolveRefTarget({ browserId: "browser-1", ref: "@e2", page })).toEqual({
      ok: false,
      reason: "missing_ref",
    });
  });

  it("marks rendered output truncation explicitly and deterministically", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [
      {
        kind: "text",
        text: "A".repeat(81_000),
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: "browser-1", page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot.endsWith('- text: "Snapshot truncated."')).toBe(true);
    expect(snapshot.stats.textLength).toBeLessThanOrEqual(80_000);
  });

  it("keeps the last rendered node when a short snapshot was capped by node count", async () => {
    const page = new SnapshotFixture();
    page.alreadyTruncated = true;
    page.snapshotNodes = [
      {
        kind: "role",
        role: "button",
        name: "Final action",
        tagName: "button",
        attributes: [],
        ref: "@e1",
        fingerprint: {
          role: "button",
          name: "Final action",
          tagName: "button",
          type: "",
          ariaLabel: "",
        },
        children: [],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: "browser-1", page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - button "Final action" [ref=@e1]',
        '- text: "Snapshot truncated."',
      ].join("\n"),
    );
  });
});

// Daseo delta 110: cross-origin frames are walked with their own copy of the script.
describe("BrowserSnapshotEngine with cross-origin frames", () => {
  const payFingerprint = {
    role: "textbox",
    name: "Card number",
    tagName: "input",
    type: "",
    ariaLabel: "Card number",
  };

  function rawSnapshot(children: unknown[], refs: unknown[], extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      marker: "__PASEO_ARIA_SNAPSHOT__",
      root: {
        kind: "role",
        role: "document",
        name: "Doc",
        tagName: "document",
        attributes: [],
        children,
      },
      refs,
      truncated: false,
      stats: {
        nodeCount: children.length + 1,
        refCount: refs.length,
        textLength: 0,
        iframeCount: 0,
        maxDepth: 1,
      },
      remaining: { nodes: 1400, refs: 499, text: 79_000 },
      ...extra,
    });
  }

  function framedPage(options: { mainTruncated?: boolean; frameGone?: boolean } = {}) {
    const frameScripts: string[] = [];
    const frame = {
      id: 42,
      parentId: null,
      outOfProcess: true,
      url: "https://js.pay.test/inner",
      async executeJavaScript(code: string) {
        frameScripts.push(code);
        if (code.includes("return windowPath(window)")) return [0];
        if (code.includes("__PASEO_ARIA_SNAPSHOT__")) {
          return rawSnapshot(
            [
              {
                kind: "role",
                role: "textbox",
                name: "Card number",
                tagName: "input",
                attributes: [],
                ref: "@e1",
                fingerprint: payFingerprint,
                children: [],
              },
            ],
            [{ ref: "@e1", fingerprint: payFingerprint }],
          );
        }
        if (code.includes("__PASEO_ARIA_FIND__")) {
          return JSON.stringify({
            marker: "__PASEO_ARIA_FIND__",
            matches: [
              {
                role: "textbox",
                name: "Card number",
                states: [],
                ref: "@e1",
                fingerprint: payFingerprint,
              },
            ],
            total: 1,
            frames: [],
          });
        }
        return { ok: true };
      },
    };
    const mainScripts: string[] = [];
    const page: SnapshotPage = {
      getURL: () => "https://shop.test/checkout",
      async executeJavaScript(code: string) {
        mainScripts.push(code);
        if (code.includes("__PASEO_ARIA_SNAPSHOT__")) {
          return rawSnapshot(
            [
              {
                kind: "role",
                role: "iframe",
                name: "Secure card form",
                tagName: "iframe",
                attributes: ["cross-origin=true", "src=https://js.pay.test/inner"],
                frame: { path: [0], depth: 1 },
                children: [],
              },
            ],
            [],
            options.mainTruncated ? { truncated: true } : {},
          );
        }
        if (code.includes("__PASEO_ARIA_FIND__")) {
          return JSON.stringify({
            marker: "__PASEO_ARIA_FIND__",
            matches: [],
            total: 0,
            frames: [{ path: [0] }],
          });
        }
        return { ok: true };
      },
      listFrames: () => (options.frameGone ? [] : [frame]),
    };
    return { page, frame, frameScripts, mainScripts };
  }

  it("puts the frame's content under its iframe with frame refs", async () => {
    const { page, frameScripts } = framedPage();
    const engine = new BrowserSnapshotEngine();

    const result = await engine.snapshot({ browserId: "browser-1", page });

    expect(result.snapshot).toBe(
      [
        '- document "Doc"',
        '  - iframe "Secure card form" [cross-origin=true src=https://js.pay.test/inner]',
        '    - textbox "Card number" [ref=@f1e1]',
      ].join("\n"),
    );
    expect(result.stats.refCount).toBe(1);
    // The frame gets what the page left of the limits.
    expect(frameScripts.find((code) => code.includes("__PASEO_ARIA_SNAPSHOT__"))).toContain(
      "const MAX_NODES = 1400;",
    );
  });

  it("runs a frame ref's scripts in its frame with the frame's own ref", async () => {
    const { page, frame, frameScripts, mainScripts } = framedPage();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });
    mainScripts.length = 0;

    const target = engine.resolveRefTarget({ browserId: "browser-1", ref: "@f1e1", page });
    const filled = await engine.fill({ browserId: "browser-1", page, ref: "@f1e1", value: "4242" });

    expect("ok" in target ? null : target.frame?.id).toBe(frame.id);
    expect("ok" in target ? "" : target.elementExpression).toContain('resolve("@e1"');
    expect(filled).toEqual({ ok: true });
    expect(frameScripts.at(-1)).toContain('"4242"');
    expect(mainScripts).toEqual([]);
  });

  it("finds inside the frame and keeps the snapshot's refs", async () => {
    const { page } = framedPage();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    const found = await engine.find({
      browserId: "browser-1",
      page,
      query: { role: "textbox", name: null, exact: false, pattern: null, limit: 10 },
    });

    expect(found).toEqual({
      matches: [{ role: "textbox", name: "Card number", states: [], ref: "@f1e1" }],
      total: 1,
    });
    expect("ok" in engine.resolveRefTarget({ browserId: "browser-1", ref: "@f1e1", page })).toBe(
      false,
    );
  });

  it("calls a frame ref stale once its frame is gone", async () => {
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page: framedPage().page });

    expect(
      engine.resolveRefTarget({
        browserId: "browser-1",
        ref: "@f1e1",
        page: framedPage({ frameGone: true }).page,
      }),
    ).toEqual({ ok: false, reason: "stale_ref" });
  });

  it("leaves frames alone once the page used up the limits", async () => {
    const { page, frameScripts } = framedPage({ mainTruncated: true });

    const result = await new BrowserSnapshotEngine().snapshot({ browserId: "browser-1", page });

    expect(frameScripts).toEqual([]);
    expect(result.snapshot).not.toContain("Card number");
    expect(result.truncated).toBe(true);
  });
});
