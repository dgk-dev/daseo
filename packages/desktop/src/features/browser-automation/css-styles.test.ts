import { describe, expect, test } from "vitest";
import {
  collectElementStyles,
  summarizeElementStyles,
  type CdpMatchedStyles,
  type RawElementStyles,
} from "./css-styles.js";

function rule(input: {
  selector: string;
  sheet?: string;
  line?: number;
  origin?: string;
  media?: string;
  properties: Array<{ name: string; value: string; important?: boolean; parsedOk?: boolean }>;
}): NonNullable<CdpMatchedStyles["matchedCSSRules"]>[number] {
  return {
    rule: {
      ...(input.sheet ? { styleSheetId: input.sheet } : {}),
      selectorList: { selectors: [{ text: input.selector }], text: input.selector },
      origin: input.origin ?? "regular",
      style: {
        cssProperties: input.properties,
        ...(input.line !== undefined ? { range: { startLine: input.line } } : {}),
      },
      ...(input.media ? { media: [{ text: input.media }] } : {}),
    },
    matchingSelectors: [0],
  };
}

function raw(matched: CdpMatchedStyles): RawElementStyles {
  return {
    element: "h2.title",
    ancestors: ["div.card", "body"],
    pageUrl: "https://shop.test/p/1",
    matched,
    computed: [
      { name: "color", value: "rgb(255, 0, 0)" },
      { name: "font-size", value: "18px" },
      { name: "margin-top", value: "0px" },
      { name: "display", value: "block" },
    ],
    sheets: {
      s1: { sourceURL: "https://cdn.test/app.css", startLine: 0, isInline: false },
      s2: { sourceURL: "https://shop.test/p/1", startLine: 40, isInline: true },
    },
  };
}

const options = { browserId: "b", ref: "@e3", maxRules: 30 };

describe("summarizeElementStyles", () => {
  test("orders rules highest precedence first and marks the losing declarations", () => {
    const result = summarizeElementStyles(
      raw({
        inlineStyle: { cssProperties: [{ name: "color", value: "red" }] },
        matchedCSSRules: [
          rule({
            selector: "h2",
            sheet: "s1",
            line: 9,
            properties: [
              { name: "color", value: "black" },
              { name: "font-size", value: "16px", important: true },
            ],
          }),
          rule({
            selector: ".card .title",
            sheet: "s2",
            line: 2,
            media: "(max-width: 768px)",
            properties: [{ name: "font-size", value: "18px" }],
          }),
          rule({
            selector: "h2",
            origin: "user-agent",
            properties: [{ name: "display", value: "block" }],
          }),
        ],
      }),
      options,
    );

    expect(result.rules).toEqual([
      { selector: "element.style", declarations: [{ name: "color", value: "red" }] },
      {
        selector: ".card .title",
        source: "https://shop.test/p/1 (inline <style>)",
        line: 43,
        conditions: ["@media (max-width: 768px)"],
        declarations: [{ name: "font-size", value: "18px", overridden: true }],
      },
      {
        selector: "h2",
        source: "https://cdn.test/app.css",
        line: 10,
        declarations: [
          { name: "color", value: "black", overridden: true },
          { name: "font-size", value: "16px", important: true },
        ],
      },
    ]);
    expect(result.userAgentRules).toBe(1);
    expect(result.computed).toEqual({ color: "rgb(255, 0, 0)", "font-size": "18px" });
  });

  test("keeps only inherited properties from ancestors and lets the element win", () => {
    const result = summarizeElementStyles(
      raw({
        matchedCSSRules: [rule({ selector: "h2", properties: [{ name: "color", value: "red" }] })],
        inherited: [
          {
            matchedCSSRules: [
              rule({
                selector: ".card",
                properties: [
                  { name: "color", value: "gray" },
                  { name: "margin-top", value: "8px" },
                ],
              }),
            ],
          },
        ],
      }),
      options,
    );

    expect(result.rules.at(-1)).toEqual({
      selector: ".card",
      inheritedFrom: "div.card",
      declarations: [{ name: "color", value: "gray", overridden: true }],
    });
  });

  test("filters by property with shorthands and longhands matching each other", () => {
    const result = summarizeElementStyles(
      raw({
        matchedCSSRules: [
          rule({
            selector: "h2",
            properties: [
              { name: "margin", value: "0" },
              { name: "color", value: "red" },
              { name: "colr", value: "blue", parsedOk: false },
            ],
          }),
        ],
      }),
      { ...options, properties: ["margin-top"] },
    );

    expect(result.rules).toEqual([
      { selector: "h2", declarations: [{ name: "margin", value: "0" }] },
    ]);
    expect(result.computed).toEqual({ "margin-top": "0px" });
  });

  test("keeps the written declarations when CDP also lists parsed copies", () => {
    const result = summarizeElementStyles(
      raw({
        inlineStyle: {
          cssProperties: [
            { name: "color", value: "purple", range: { startLine: 0 } },
            { name: "color", value: "purple" },
          ],
        },
      }),
      options,
    );

    expect(result.rules).toEqual([
      { selector: "element.style", declarations: [{ name: "color", value: "purple" }] },
    ]);
  });

  test("the later of two declarations in one rule wins", () => {
    const result = summarizeElementStyles(
      raw({
        matchedCSSRules: [
          rule({
            selector: "h2",
            properties: [
              { name: "display", value: "-webkit-box" },
              { name: "display", value: "flex" },
            ],
          }),
        ],
      }),
      options,
    );

    expect(result.rules[0]?.declarations).toEqual([
      { name: "display", value: "-webkit-box", overridden: true },
      { name: "display", value: "flex" },
    ]);
  });
});

describe("collectElementStyles", () => {
  test("maps stylesheets from styleSheetAdded and turns CSS off afterwards", async () => {
    const sent: string[] = [];
    let listener: ((method: string, params?: Record<string, unknown>) => void) | null = null;
    const result = await collectElementStyles({
      elementExpression: "document.body",
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      send: async (command) => {
        sent.push(command);
        switch (command) {
          case "Runtime.evaluate":
            return { result: { objectId: "obj-1" } };
          case "Runtime.callFunctionOn":
            return {
              result: {
                value: { element: "body", ancestors: ["html"], pageUrl: "https://a.test/" },
              },
            };
          case "CSS.enable":
            listener?.("CSS.styleSheetAdded", {
              header: { styleSheetId: "s1", sourceURL: "https://a.test/a.css", startLine: 0 },
            });
            return {};
          case "DOM.requestNode":
            return { nodeId: 7 };
          case "CSS.getMatchedStylesForNode":
            return { matchedCSSRules: [] };
          case "CSS.getComputedStyleForNode":
            return { computedStyle: [{ name: "color", value: "red" }] };
          default:
            return {};
        }
      },
    });

    expect(result).toMatchObject({
      element: "body",
      sheets: { s1: { sourceURL: "https://a.test/a.css", startLine: 0, isInline: false } },
    });
    expect(sent.slice(-3)).toEqual(["CSS.disable", "DOM.disable", "Runtime.releaseObjectGroup"]);
    expect(listener).toBeNull();
  });

  test("reports a missing element as stale", async () => {
    const result = await collectElementStyles({
      elementExpression: "null",
      subscribe: () => () => undefined,
      send: async (command) =>
        command === "Runtime.evaluate" ? { result: { subtype: "null", type: "object" } } : {},
    });

    expect(result).toBe("stale_ref");
  });
});
