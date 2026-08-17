import type { StyleProp, TextStyle } from "react-native";

const MARKDOWN_HEADING_NODE_TYPES = new Set([
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
]);

interface MarkdownParentNode {
  type: string;
}

type MarkdownTextStyles = Record<string, TextStyle>;

export function resolveMarkdownTextStyle(
  styles: MarkdownTextStyles,
  parent: readonly MarkdownParentNode[],
  baseStyle: TextStyle = styles.text ?? {},
): StyleProp<TextStyle> {
  return parent.some((node) => MARKDOWN_HEADING_NODE_TYPES.has(node.type))
    ? [baseStyle, styles.heading_text ?? {}]
    : baseStyle;
}
