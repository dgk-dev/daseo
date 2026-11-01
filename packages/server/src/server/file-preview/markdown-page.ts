import MarkdownIt from "markdown-it";

// Daseo delta 75: Chrome shows a `.md` file as raw text (or downloads it), so the preview route
// renders markdown into one self-contained page. Raw HTML in the source is escaped, the page
// loads nothing remote except images the markdown names, and it carries no script; the route
// adds a CSP that enforces the same.

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 820px;
  padding: 24px 18px 64px;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo",
    "Noto Sans KR", "Malgun Gothic", sans-serif;
  color: #1f2328;
  background: #ffffff;
  overflow-wrap: anywhere;
}
@media (prefers-color-scheme: dark) {
  body { color: #e6e6e6; background: #16181d; }
  a { color: #7aa2f7; }
  code, pre { background: #22252c; }
  th, td, blockquote, hr { border-color: #3a3f4b; }
  blockquote { color: #a9b1bd; }
}
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.15em; }
p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }
a { color: #0969da; }
img { max-width: 100%; height: auto; }
code { font: 0.9em/1.5 ui-monospace, "SF Mono", "D2Coding", Menlo, monospace; background: #f3f4f6;
  padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: #f3f4f6; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 2em 0; }
`;

export function renderMarkdownPage(input: { title: string; source: string }): string {
  const body = markdown.render(input.source);
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
