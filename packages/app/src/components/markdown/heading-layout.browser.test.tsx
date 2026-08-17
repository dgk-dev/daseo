import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text as RNText, View, type TextStyle, type ViewStyle } from "react-native";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { darkTheme } from "@/styles/theme";

const HEADING_DATA_SET = { testid: "heading" };
const MARKDOWN_STYLES = createMarkdownStyles(darkTheme);
const HEADING_CONTAINER_STYLE: ViewStyle = {
  flexDirection: MARKDOWN_STYLES.heading3.flexDirection,
  flexWrap: MARKDOWN_STYLES.heading3.flexWrap,
  alignItems: MARKDOWN_STYLES.heading3.alignItems,
  alignContent: MARKDOWN_STYLES.heading3.alignContent,
  alignSelf: MARKDOWN_STYLES.heading3.alignSelf,
  flexShrink: MARKDOWN_STYLES.heading3.flexShrink,
  minWidth: MARKDOWN_STYLES.heading3.minWidth,
  width: MARKDOWN_STYLES.heading3.width,
  maxWidth: MARKDOWN_STYLES.heading3.maxWidth,
  overflow: MARKDOWN_STYLES.heading3.overflow,
};
const HEADING_TEXT_STYLE: TextStyle[] = [
  {
    color: MARKDOWN_STYLES.heading3.color,
    fontSize: MARKDOWN_STYLES.heading3.fontSize,
    fontWeight: MARKDOWN_STYLES.heading3.fontWeight,
    lineHeight: MARKDOWN_STYLES.heading3.lineHeight,
  },
  MARKDOWN_STYLES.text,
  MARKDOWN_STYLES.heading_text,
];

function findTextNode(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent === text) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`Unable to find text node: ${text}`);
}

function getLineRects(root: Element, text: string): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(findTextNode(root, text));
  return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
}

describe("Markdown CJK heading layout", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
  });

  async function renderHeading(width: number) {
    container = document.createElement("div");
    container.style.width = `${width}px`;
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <View style={HEADING_CONTAINER_STYLE} dataSet={HEADING_DATA_SET}>
          <RNText style={HEADING_TEXT_STYLE}>적용 결과</RNText>
        </View>,
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const heading = container.querySelector('[data-testid="heading"]');
    if (!heading) throw new Error("Heading did not render");
    return heading;
  }

  it("keeps a normal-width Korean heading on one line", async () => {
    const heading = await renderHeading(180);
    expect(heading.textContent).toBe("적용 결과");
    expect(getLineRects(heading, "적용 결과")).toHaveLength(1);
  });

  it("grows to contain every line when a Korean heading must wrap", async () => {
    const heading = await renderHeading(58);
    const lineRects = getLineRects(heading, "적용 결과");
    const headingRect = heading.getBoundingClientRect();
    const contentBottom = Math.max(...lineRects.map((rect) => rect.bottom));

    expect(lineRects.length).toBeGreaterThanOrEqual(2);
    expect(heading.textContent).toBe("적용 결과");
    expect(getComputedStyle(heading).overflow).toBe("visible");
    expect(headingRect.bottom + 0.5).toBeGreaterThanOrEqual(contentBottom);
    expect(headingRect.height).toBeGreaterThanOrEqual(darkTheme.fontSize.xl * 2);
  });
});
