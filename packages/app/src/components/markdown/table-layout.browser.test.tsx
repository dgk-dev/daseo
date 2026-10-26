import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollView, Text, View } from "react-native";
import type { ASTNode } from "react-native-markdown-display";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownStyles } from "@/styles/markdown-styles";
import { darkTheme } from "@/styles/theme";
import { tableCellStyle, tableScrollStyles } from "./table-columns";

function node(type: string, children: ASTNode[] = [], content = "", index = 0): ASTNode {
  return { type, children, content, key: `${type}-${index}`, index, attributes: {} } as ASTNode;
}

function buildTable(rows: string[][]): { table: ASTNode; tbody: ASTNode; trs: ASTNode[] } {
  const trs = rows.map((cells, rowIndex) =>
    node(
      "tr",
      cells.map((text, index) => node("td", [node("text", [], text)], "", index)),
      "",
      rowIndex,
    ),
  );
  const tbody = node("tbody", trs);
  return { table: node("table", [tbody]), tbody, trs };
}

const NARROW_SCREEN = { width: 320 } as const;

function TableFixture({ rows }: { rows: string[][] }) {
  const styles = createMarkdownStyles(darkTheme);
  const { table, tbody, trs } = buildTable(rows);
  return (
    <View style={NARROW_SCREEN}>
      <ScrollView
        horizontal
        testID="table-scroll"
        style={[styles.table, tableScrollStyles.frame]}
        contentContainerStyle={tableScrollStyles.content}
      >
        <View style={tableScrollStyles.table}>
          {trs.map((tr) => (
            <View key={tr.key} style={styles.tr}>
              {tr.children.map((cell) => (
                <View
                  key={cell.key}
                  testID={`cell-${tr.index}-${cell.index}`}
                  style={tableCellStyle(styles.td, cell, [tr, tbody, table], styles.td)}
                >
                  <Text style={styles.td}>{cell.children[0]?.content}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

describe("assistant table layout on a narrow screen", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function render(rows: string[][]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<TableFixture rows={rows} />));
    const scroll = container.querySelector('[data-testid="table-scroll"]') as HTMLElement;
    const host = container;
    const cell = (row: number, column: number) =>
      (
        host.querySelector(`[data-testid="cell-${row}-${column}"]`) as HTMLElement
      ).getBoundingClientRect();
    return { scroll, cell };
  }

  it("scrolls sideways when the columns do not fit, keeping columns aligned", () => {
    const prose = "긴 설명이 들어가는 칸으로 좁은 화면에서도 읽을 수 있어야 합니다";
    const { scroll, cell } = render([
      ["항목", "설명", "비고", "상태"],
      ["A", prose, prose, "완료"],
    ]);
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    for (let column = 0; column < 4; column += 1) {
      expect(cell(0, column).left).toBeCloseTo(cell(1, column).left, 0);
      expect(cell(0, column).width).toBeCloseTo(cell(1, column).width, 0);
    }
    expect(cell(1, 1).width).toBeGreaterThan(cell(1, 0).width * 1.5);
    // Prose wraps at a readable width instead of stretching to one line.
    expect(cell(1, 1).width).toBeLessThan(160);
  });

  it("fills the width without scrolling when the columns fit", () => {
    const { scroll, cell } = render([
      ["이름", "값"],
      ["모델", "Opus 5.5"],
    ]);
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
    const rowWidth = cell(0, 1).right - cell(0, 0).left;
    expect(rowWidth).toBeGreaterThan(scroll.clientWidth - 4);
  });
});
