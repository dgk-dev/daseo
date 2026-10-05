import { READ_SCRIPT_MARKER } from "./read-script.js";

export interface ReadPageContent {
  scope: "main" | "page" | "ref";
  /** Why a `main` read became `page`. */
  mainFallback?: "product_page" | "no_article";
  /** Structured-data summary (when found) followed by the Markdown body. */
  content: string;
  links: number;
  structuredDataFound: boolean;
}

export type ReadScriptOutcome = { kind: "content"; page: ReadPageContent } | { kind: "stale_ref" };

const TRUNCATION_NOTE = "\n\n[truncated]";

export function parseReadScriptResult(value: unknown): ReadScriptOutcome | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.marker !== READ_SCRIPT_MARKER) {
    return null;
  }
  if (record.staleRef === true) {
    return { kind: "stale_ref" };
  }
  const scope = record.scope;
  if (
    (scope !== "main" && scope !== "page" && scope !== "ref") ||
    typeof record.content !== "string"
  ) {
    return null;
  }
  const mainFallback = record.mainFallback;
  return {
    kind: "content",
    page: {
      scope,
      ...(mainFallback === "product_page" || mainFallback === "no_article" ? { mainFallback } : {}),
      content: record.content,
      links: typeof record.links === "number" && Number.isFinite(record.links) ? record.links : 0,
      structuredDataFound: record.structuredDataFound === true,
    },
  };
}

/** Cuts at `maxChars` without splitting a surrogate pair, and says so. */
export function capReadContent(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  let end = maxChars;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return { content: `${content.slice(0, end).trimEnd()}${TRUNCATION_NOTE}`, truncated: true };
}
