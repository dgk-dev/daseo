// Daseo delta 123: one line per stage of opening and registering a browser tab. The desktop main
// process forwards this renderer's console into main.log (renderer-console-log.ts), so the line
// lands next to main's own `[browser-webview] registered`. Before, a tab that never registered
// left nothing at all in main.log (2026-11-16: seven failed browser_new_tab calls). One string per
// line: the console forwarder keeps text, not objects. URLs are logged as origin and path.

export type BrowserTabStageFields = Record<string, string | number | boolean | null | undefined>;

export function redactBrowserUrlForLog(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return `${parsed.protocol}…`;
  } catch {
    return "<invalid url>";
  }
}

export function formatBrowserTabStage(stage: string, fields: BrowserTabStageFields): string {
  const parts = [`[browser-tab] ${stage}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    const text =
      (key === "url" || key.endsWith("Url")) && typeof value === "string"
        ? redactBrowserUrlForLog(value)
        : String(value);
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

export function logBrowserTabStage(stage: string, fields: BrowserTabStageFields): void {
  console.info(formatBrowserTabStage(stage, fields));
}
