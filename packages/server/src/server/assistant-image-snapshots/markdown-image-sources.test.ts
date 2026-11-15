import { describe, expect, test } from "vitest";

import {
  createMarkdownImageScanState,
  rewriteMarkdownImageSources,
  splitTrailingIncompleteMarkdownImage,
} from "./markdown-image-sources.js";

function rewriteAll(texts: string[]): string[] {
  const state = createMarkdownImageScanState();
  return texts.map((text) =>
    rewriteMarkdownImageSources({
      text,
      state,
      rewrite: (source) => `<snap:${source}>`,
    }),
  );
}

describe("rewriteMarkdownImageSources", () => {
  test("replaces the destination of each image and keeps alt text and title", () => {
    expect(rewriteAll(['Before ![shot](/tmp/a.png) and ![b](./b.png "title") after'])).toEqual([
      'Before ![shot](<snap:/tmp/a.png>) and ![b](<snap:./b.png> "title") after',
    ]);
  });

  test("passes angle-bracket and escaped destinations unescaped", () => {
    expect(rewriteAll(["![a](</tmp/with space.png>) ![b](/tmp/paren\\).png)"])).toEqual([
      "![a](<snap:/tmp/with space.png>) ![b](<snap:/tmp/paren).png>)",
    ]);
  });

  test("leaves images inside inline code and fenced code untouched", () => {
    expect(
      rewriteAll(["Use `![x](/tmp/a.png)` here\n```md\n![x](/tmp/b.png)\n```\n![y](/tmp/c.png)"]),
    ).toEqual([
      "Use `![x](/tmp/a.png)` here\n```md\n![x](/tmp/b.png)\n```\n![y](<snap:/tmp/c.png>)",
    ]);
  });

  test("a fence opened in one streamed item still covers the next", () => {
    expect(rewriteAll(["```\n", "![x](/tmp/a.png)\n", "```\n![y](/tmp/b.png)"])).toEqual([
      "```\n",
      "![x](/tmp/a.png)\n",
      "```\n![y](<snap:/tmp/b.png>)",
    ]);
  });

  test("keeps the source when the rewrite returns null", () => {
    const state = createMarkdownImageScanState();
    expect(
      rewriteMarkdownImageSources({ text: "![a](/tmp/a.png)", state, rewrite: () => null }),
    ).toBe("![a](/tmp/a.png)");
  });

  test("ignores links and unfinished images", () => {
    expect(rewriteAll(["[link](/tmp/a.png) ![open](/tmp/a"])).toEqual([
      "[link](/tmp/a.png) ![open](/tmp/a",
    ]);
  });
});

describe("splitTrailingIncompleteMarkdownImage", () => {
  test("holds back an image whose Markdown has not finished", () => {
    expect(splitTrailingIncompleteMarkdownImage("See ![shot](/tmp/sh")).toEqual({
      complete: "See ",
      pending: "![shot](/tmp/sh",
    });
    expect(splitTrailingIncompleteMarkdownImage("See ![sh")).toEqual({
      complete: "See ",
      pending: "![sh",
    });
    expect(splitTrailingIncompleteMarkdownImage("See !")).toEqual({
      complete: "See ",
      pending: "!",
    });
  });

  test("releases finished images and plain text", () => {
    expect(splitTrailingIncompleteMarkdownImage("See ![a](/tmp/a.png) done")).toEqual({
      complete: "See ![a](/tmp/a.png) done",
      pending: "",
    });
    expect(splitTrailingIncompleteMarkdownImage("![a] is not an image")).toEqual({
      complete: "![a] is not an image",
      pending: "",
    });
  });
});
