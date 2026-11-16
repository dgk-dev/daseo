// Daseo delta 123: one main.log line per stage of a tab's navigation, so a navigate that never
// answered says which stage it reached (2026-11-16: four navigations on Search Console answered
// only "has been loading 45s", with nothing in main.log). URLs are logged as origin and path:
// query strings and fragments carry tokens and search terms.
import log from "electron-log/main";

export type BrowserStageFields = Record<string, string | number | boolean | null | undefined>;

/** Origin and path of an http(s) URL; the scheme alone for anything else. */
export function redactUrlForLog(url: string | null | undefined): string {
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

/** Fields named `url` or ending in `Url` are redacted; everything else is logged as given. */
export function redactStageFields(fields: BrowserStageFields): BrowserStageFields {
  const redacted: BrowserStageFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    redacted[key] =
      (key === "url" || key.endsWith("Url")) && typeof value === "string"
        ? redactUrlForLog(value)
        : value;
  }
  return redacted;
}

export function logBrowserStage(scope: string, stage: string, fields: BrowserStageFields): void {
  log.info(`[${scope}] ${stage}`, redactStageFields(fields));
}
