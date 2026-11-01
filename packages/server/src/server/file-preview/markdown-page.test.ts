import { describe, expect, it } from "vitest";
import { renderMarkdownPage } from "./markdown-page.js";

describe("renderMarkdownPage", () => {
  it("renders a readable, self-contained page", () => {
    const page = renderMarkdownPage({
      title: "보고서 <draft>.md",
      source: "# 결론\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- item\n\n`code` https://example.com",
    });

    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('name="viewport"');
    expect(page).toContain("<title>보고서 &lt;draft&gt;.md</title>");
    expect(page).toContain("<h1>결론</h1>");
    expect(page).toContain("<table>");
    expect(page).toContain("<code>code</code>");
    expect(page).toContain('<a href="https://example.com">');
    expect(page).not.toMatch(/<link|<script|src="http/i);
  });

  it("escapes raw HTML and drops script links", () => {
    const page = renderMarkdownPage({
      title: "x.md",
      source:
        "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[go](javascript:alert(1))",
    });

    expect(page).not.toContain("<script>alert");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<img src=x");
    expect(page).not.toContain('href="javascript:');
  });
});
