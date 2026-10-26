import { describe, expect, it } from "vitest";
import type { ASTNode } from "react-native-markdown-display";
import { findTableAncestor, getTableColumnLayout, measureTextUnits } from "./table-columns";

function node(type: string, children: ASTNode[] = [], content = ""): ASTNode {
  return { type, children, content, key: type, index: 0, attributes: {} } as unknown as ASTNode;
}

function row(type: "th" | "td", cells: string[]): ASTNode {
  return node(
    "tr",
    cells.map((text) => node(type, [node("text", [], text)])),
  );
}

describe("table column layout", () => {
  const table = node("table", [
    node("thead", [row("th", ["항목", "설명"])]),
    node("tbody", [
      row("td", ["A", "긴 설명이 들어가는 칸으로 화면이 좁으면 줄바꿈되어야 하는 내용입니다"]),
    ]),
  ]);

  it("clamps each column between 3em and 7em plus padding", () => {
    const layout = getTableColumnLayout(table, 10, 8);
    expect(layout.basis).toEqual([30 + 17, 70 + 17]);
  });

  it("gives the longer column the larger grow share", () => {
    const layout = getTableColumnLayout(table, 10, 8);
    expect(layout.grow[1]).toBeGreaterThan(layout.grow[0] ?? 0);
  });

  it("counts Hangul as full width and Latin as about half", () => {
    expect(measureTextUnits("가나")).toBe(2);
    expect(measureTextUnits("ab")).toBeCloseTo(1.16);
  });

  it("finds the table among ancestors", () => {
    expect(findTableAncestor([node("tr"), node("tbody"), table])).toBe(table);
    expect(findTableAncestor([node("paragraph")])).toBeUndefined();
  });
});
