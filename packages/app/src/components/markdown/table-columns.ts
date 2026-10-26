import type { TextStyle, ViewStyle } from "react-native";
import type { ASTNode } from "react-native-markdown-display";

/**
 * Daseo delta 72: column sizing for assistant markdown tables.
 *
 * Every row is its own flex row, so columns only line up when each row gives a
 * column the same basis and grow. The basis is the column's widest cell, clamped
 * between 3em and 7em: a short column stays narrow, a prose column wraps at a
 * readable width instead of being squeezed to one word per line. The grow share
 * follows content width, so on a wide screen the long columns take the spare
 * room. When the bases add up to more than the screen, the table scrolls
 * sideways instead of crushing every column.
 */
export interface TableColumnLayout {
  basis: number[];
  grow: number[];
}

const MIN_EM = 3;
const COMFORT_EM = 7;

const cache = new WeakMap<ASTNode, Map<string, TableColumnLayout>>();

export function getTableColumnLayout(
  table: ASTNode,
  fontSize: number,
  horizontalPadding: number,
): TableColumnLayout {
  const key = `${fontSize}:${horizontalPadding}`;
  let byKey = cache.get(table);
  const cached = byKey?.get(key);
  if (cached) return cached;

  const widest: number[] = [];
  for (const row of collectRows(table)) {
    row.children.forEach((cell, index) => {
      const units = measureTextUnits(nodeText(cell));
      widest[index] = Math.max(widest[index] ?? 0, units);
    });
  }

  const chrome = horizontalPadding * 2 + 1;
  const layout: TableColumnLayout = {
    basis: widest.map(
      (units) => Math.round(Math.min(Math.max(units, MIN_EM), COMFORT_EM) * fontSize) + chrome,
    ),
    grow: widest.map((units) => Math.max(units, 1)),
  };

  if (!byKey) {
    byKey = new Map();
    cache.set(table, byKey);
  }
  byKey.set(key, layout);
  return layout;
}

/** The table scrolls inside a frame that keeps the shared border and margins. */
export const tableScrollStyles = {
  frame: { flexGrow: 0, overflow: "hidden" },
  content: { minWidth: "100%" },
  table: { flexGrow: 1 },
} as const satisfies Record<string, ViewStyle>;

type CellStyle = TextStyle & ViewStyle & { [key: string]: unknown };

/**
 * A th/td view style with its column's basis and grow. The shared td style carries
 * `flex: 1`, which would split the row evenly, so it is dropped here.
 */
export function tableCellStyle(
  viewStyle: CellStyle | undefined,
  node: ASTNode,
  parent: ASTNode[],
  cellStyle: CellStyle | undefined,
): ViewStyle | undefined {
  const table = findTableAncestor(parent);
  if (!table || !viewStyle) return viewStyle;
  const fontSize = typeof cellStyle?.fontSize === "number" ? cellStyle.fontSize : 14;
  const padding = typeof cellStyle?.padding === "number" ? cellStyle.padding : 8;
  const layout = getTableColumnLayout(table, fontSize, padding);
  const basis = layout.basis[node.index];
  if (basis === undefined) return viewStyle;
  const { flex: _flex, ...rest } = viewStyle;
  // `width` as well as `flexBasis`: on web a horizontal scroll container sizes to
  // its children's max-content, and a cell without a definite width would claim
  // its whole text on one line before wrapping.
  return {
    ...rest,
    width: basis,
    flexBasis: basis,
    flexGrow: layout.grow[node.index],
    flexShrink: 0,
  };
}

export function findTableAncestor(parent: ASTNode[] | undefined): ASTNode | undefined {
  return Array.isArray(parent) ? parent.find((node) => node?.type === "table") : undefined;
}

/** Width of a string in ems: Hangul, CJK and full-width forms are 1, the rest about half. */
export function measureTextUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) units += 1.1;
    else if (isWide(code)) units += 1;
    else units += 0.58;
  }
  return units;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function collectRows(node: ASTNode): ASTNode[] {
  if (node.type === "tr") return [node];
  return (node.children ?? []).flatMap(collectRows);
}

function nodeText(node: ASTNode): string {
  if (!node.children?.length) return node.content ?? "";
  return node.children.map(nodeText).join("");
}
