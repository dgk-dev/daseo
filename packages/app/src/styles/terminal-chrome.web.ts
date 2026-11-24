// Daseo delta 55: the Daseo theme's terminal chrome on web and Electron. Theme radii already
// resolve to 0; this rule also squares the literal radii (pills, badges, sheets), and text
// fields get a block cursor in the accent (CSS caret-shape, Chromium 146 in Electron 41).
const STYLE_ID = "daseo-terminal-chrome";

function rule(caretColor: string): string {
  const color = caretColor.replace(/[^#(),.\w\s%-]/g, "");
  return [
    ":is(#root, #overlay-root) *, :is(#root, #overlay-root) *::before, :is(#root, #overlay-root) *::after{border-radius:0 !important;}",
    `:is(#root, #overlay-root) :is(textarea, input){caret-shape:block;caret-color:${color};}`,
  ].join("\n");
}

export function applyTerminalChrome(input: { enabled: boolean; caretColor: string }): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID);
  if (!input.enabled) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = rule(input.caretColor);
}
