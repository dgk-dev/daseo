import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text as RNText, View, type TextStyle, type ViewStyle } from "react-native";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { darkTheme } from "@/styles/theme";

const HEADING_DATA_SET = { testid: "heading" };

function resolveHeadingStyles(): {
  container: ViewStyle;
  text: TextStyle[];
} {
  const markdownStyles = createMarkdownStyles(darkTheme);
  return {
    container: {
      flexDirection: markdownStyles.heading3.flexDirection,
      flexWrap: markdownStyles.heading3.flexWrap,
      alignItems: markdownStyles.heading3.alignItems,
      alignContent: markdownStyles.heading3.alignContent,
      alignSelf: markdownStyles.heading3.alignSelf,
      flexShrink: markdownStyles.heading3.flexShrink,
      minWidth: markdownStyles.heading3.minWidth,
      width: markdownStyles.heading3.width,
      maxWidth: markdownStyles.heading3.maxWidth,
      overflow: markdownStyles.heading3.overflow,
    },
    text: [
      {
        color: markdownStyles.heading3.color,
        fontSize: markdownStyles.heading3.fontSize,
        fontWeight: markdownStyles.heading3.fontWeight,
        lineHeight: markdownStyles.heading3.lineHeight,
      },
      markdownStyles.text,
      markdownStyles.heading_text,
    ],
  };
}

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

describe("Markdown CJK heading layout on web", () => {
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
    const headingStyles = resolveHeadingStyles();
    container = document.createElement("div");
    container.style.width = `${width}px`;
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <View style={headingStyles.container} dataSet={HEADING_DATA_SET}>
          <RNText style={headingStyles.text}>적용 결과</RNText>
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
