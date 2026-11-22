import type { LoginBannerHeader, LoginBannerNote } from "./login-banner.js";

/**
 * Daseo delta 144: the host's dev motd file (`~/.cache/dev-motd/motd.json`), written by
 * pi-local's dev-memory-guard every 120 s (update-motd.d model: the expensive checks run there,
 * the daemon only reads the result when a banner is asked for). Other hosts have no such file.
 *
 * Contract (schema 1): `{ schema, generatedAt, headers: [{ label, value }], notes: [{ severity,
 * text }] }`. Unknown fields are ignored, malformed entries dropped, headers capped at 4 and notes
 * at 6. A file older than 10 minutes contributes none of its lines and one warning instead.
 */
export const DEV_MOTD_MAX_BYTES = 64 * 1024;
export const DEV_MOTD_STALE_AFTER_MS = 10 * 60_000;
const MAX_HEADERS = 4;
const MAX_NOTES = 6;

export interface DevMotd {
  headers: LoginBannerHeader[];
  notes: LoginBannerNote[];
}

const EMPTY: DevMotd = { headers: [], notes: [] };

/** `content` is the file's text, or null when there is no file. */
export function parseDevMotd(content: string | null, nowMs: number): DevMotd {
  if (content === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (!isRecord(parsed) || parsed.schema !== 1 || typeof parsed.generatedAt !== "string") {
    return EMPTY;
  }
  const generatedAt = Date.parse(parsed.generatedAt);
  if (!Number.isFinite(generatedAt)) return EMPTY;
  const ageMs = nowMs - generatedAt;
  if (ageMs > DEV_MOTD_STALE_AFTER_MS) {
    const minutes = Math.floor(ageMs / 60_000);
    return {
      headers: [],
      notes: [
        { severity: "warning", text: `dev-memory-guard has not reported for ${minutes} minutes` },
      ],
    };
  }
  return { headers: parseHeaders(parsed.headers), notes: parseNotes(parsed.notes) };
}

function parseHeaders(value: unknown): LoginBannerHeader[] {
  const headers: LoginBannerHeader[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (headers.length >= MAX_HEADERS) break;
    if (!isRecord(entry)) continue;
    const label = singleLine(entry.label);
    const text = singleLine(entry.value);
    if (label && text) headers.push({ label, value: text });
  }
  return headers;
}

function parseNotes(value: unknown): LoginBannerNote[] {
  const notes: LoginBannerNote[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (notes.length >= MAX_NOTES) break;
    if (!isRecord(entry)) continue;
    const text = singleLine(entry.text);
    if (text && (entry.severity === "warning" || entry.severity === "critical")) {
      notes.push({ severity: entry.severity, text });
    }
  }
  return notes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One banner line: a line break or tab in the file must not break the banner's layout. */
function singleLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}
