import { isSecretFieldName, redactCredentialHeader } from "./network-capture.js";
import type { Har, HarNameValue } from "./network-har.js";

// Daseo delta 99. The sanitizer every network export goes through; there is no raw export. A HAR
// is fed to third-party converters and shared, and Chrome's own sanitized export (Cookie,
// Set-Cookie, Authorization, the cookie arrays) misses tokens in URLs and bodies: a test server
// that echoed a posted password put it straight into the generated OpenAPI file. So:
//
// - S1 credential headers keep their name (and Authorization its scheme word, cookies their name
//   and attributes); the value is replaced.
// - S2 secret query, form, multipart, and JSON fields (request and response bodies, and JSON in
//   WebSocket and EventSource messages) keep their key; string and number values are replaced.
// - S3 every value replaced by S1 or S2 that is at least 8 characters gets a stable
//   `<redacted-N>` for the whole file, and every other occurrence of it, URL-encoded too, gets
//   the same placeholder, so "received here, sent there" stays readable without the value.
// - S4 JWT-shaped strings anywhere become `<redacted-jwt-N>` (whole token: claims can be
//   personal data).
//
// Personal data in bodies (names, e-mails, addresses) is not removed.

/** Bumped when a rule changes, so a reader can tell which rules a file went through. */
export const SANITIZE_RULES_VERSION = "1";

export interface RedactionCounts {
  headers: number;
  cookies: number;
  parameters: number;
  bodyFields: number;
  propagated: number;
  jwts: number;
}

const PLACEHOLDER_MIN_LENGTH = 8;
const SHORT_PLACEHOLDER = "<redacted>";

// S2 parameter and field names beyond the password and one-time-code names `list` already
// redacts. Compared after lowercasing and removing everything but letters and digits.
const SECRET_PARAMETER_NAMES = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "clientsecret",
  "apikey",
  "signature",
  "sig",
  "session",
  "sessionid",
  "sid",
  "jwt",
  "auth",
  "credential",
  "credentials",
  "codeverifier",
]);
// Names ending in these are secrets too (csrf_token, authToken, x_api_key, PHPSESSID's cousins).
const SECRET_PARAMETER_SUFFIX = /(token|secret|apikey|sessionid)$/;
const OAUTH_CONTEXT_NAMES = new Set(["state", "redirecturi", "granttype"]);
// Header values that are URLs: their query parameters go through S2 like the request URL's.
const URL_HEADERS = new Set(["location", "referer", "content-location"]);
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretParameter(name: string, value: string, oauthContext: boolean): boolean {
  if (isSecretFieldName(name)) return true;
  const normalized = normalizeName(name);
  if (SECRET_PARAMETER_NAMES.has(normalized) || SECRET_PARAMETER_SUFFIX.test(normalized)) {
    return true;
  }
  if (normalized === "key") return value.length >= 16;
  if (normalized === "code") return oauthContext;
  return false;
}

function hasOAuthContext(names: Iterable<string>): boolean {
  for (const name of names) if (OAUTH_CONTEXT_NAMES.has(normalizeName(name))) return true;
  return false;
}

class Placeholders {
  public readonly long = new Map<string, string>();
  private readonly jwts = new Map<string, string>();

  public replace(value: string): string {
    const secret = value.trim();
    if (!secret || /^<redacted(-[a-z]*\d+)?>$/.test(secret)) return value;
    if (secret.length < PLACEHOLDER_MIN_LENGTH) return SHORT_PLACEHOLDER;
    let placeholder = this.long.get(secret);
    if (!placeholder) {
      placeholder = `<redacted-${this.long.size + 1}>`;
      this.long.set(secret, placeholder);
    }
    return placeholder;
  }

  public jwt(token: string): string {
    let placeholder = this.jwts.get(token);
    if (!placeholder) {
      placeholder = `<redacted-jwt-${this.jwts.size + 1}>`;
      this.jwts.set(token, placeholder);
    }
    return placeholder;
  }
}

/** Sanitizes a HAR built by `buildHar` in place and returns it with what was replaced. */
export function sanitizeHar(har: Har): { har: Har; redactions: RedactionCounts } {
  const counts: RedactionCounts = {
    headers: 0,
    cookies: 0,
    parameters: 0,
    bodyFields: 0,
    propagated: 0,
    jwts: 0,
  };
  const placeholders = new Placeholders();
  const replaceUrl = (url: string, count: boolean) =>
    sanitizeUrl(url, placeholders, count ? counts : null);

  // S1 and S2: replace by rule, remembering each value.
  for (const page of har.log.pages ?? []) page.title = replaceUrl(page.title, false);
  for (const entry of har.log.entries) {
    const { request, response } = entry;
    request.url = replaceUrl(request.url, true);
    response.redirectURL = replaceUrl(response.redirectURL, false);
    if (entry._initiator?.url) entry._initiator.url = replaceUrl(entry._initiator.url, false);
    sanitizeHeaders(request.headers, placeholders, counts, replaceUrl);
    sanitizeHeaders(response.headers, placeholders, counts, replaceUrl);
    for (const cookie of [...request.cookies, ...response.cookies]) {
      cookie.value = placeholders.replace(cookie.value);
    }
    sanitizeParameters(request.queryString, placeholders, null);
    if (request.postData) {
      request.postData.text = sanitizeBody(
        request.postData.text,
        request.postData.mimeType,
        placeholders,
        counts,
        true,
      );
    }
    if (response.content.text !== undefined) {
      response.content.text = sanitizeBody(
        response.content.text,
        response.content.mimeType,
        placeholders,
        counts,
        false,
      );
    }
    for (const message of [
      ...(entry._webSocketMessages ?? []),
      ...(entry._eventSourceMessages ?? []),
    ]) {
      message.data = sanitizeJsonText(message.data, placeholders, counts) ?? message.data;
    }
  }

  // S3 and S4: every other occurrence of a replaced value, then JWTs, anywhere in the file.
  const propagate = propagationPattern(placeholders.long);
  mapStrings(har.log, (text) => {
    let result = text;
    if (propagate) {
      result = result.replace(propagate.pattern, (match) => {
        counts.propagated += 1;
        return propagate.placeholders.get(match) ?? SHORT_PLACEHOLDER;
      });
    }
    return result.replace(JWT_PATTERN, (token) => {
      counts.jwts += 1;
      return placeholders.jwt(token);
    });
  });

  har.log._daseo = { sanitized: true, rules: SANITIZE_RULES_VERSION };
  return { har, redactions: counts };
}

function sanitizeHeaders(
  headers: HarNameValue[],
  placeholders: Placeholders,
  counts: RedactionCounts,
  replaceUrl: (url: string, count: boolean) => string,
): void {
  for (const header of headers) {
    const redacted = redactCredentialHeader(header.name, header.value, (secret, kind) => {
      counts[kind === "cookie" ? "cookies" : "headers"] += 1;
      return placeholders.replace(secret);
    });
    if (redacted !== null) {
      header.value = redacted;
    } else if (URL_HEADERS.has(header.name.toLowerCase())) {
      header.value = replaceUrl(header.value, false);
    }
  }
}

function sanitizeParameters(
  parameters: HarNameValue[],
  placeholders: Placeholders,
  counts: RedactionCounts | null,
): void {
  const oauth = hasOAuthContext(parameters.map((parameter) => parameter.name));
  for (const parameter of parameters) {
    if (parameter.value && isSecretParameter(parameter.name, parameter.value, oauth)) {
      parameter.value = placeholders.replace(parameter.value);
      if (counts) counts.parameters += 1;
    }
  }
}

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** Rewrites only the secret pairs of an `a=1&b=2` string, leaving the others byte for byte. */
function sanitizeFormPairs(
  query: string,
  placeholders: Placeholders,
  counts: RedactionCounts | null,
): string {
  const pairs = query.split("&").map((raw) => {
    const equals = raw.indexOf("=");
    return {
      raw,
      rawName: equals < 0 ? raw : raw.slice(0, equals),
      name: decodeComponent(equals < 0 ? raw : raw.slice(0, equals)),
      value: equals < 0 ? "" : decodeComponent(raw.slice(equals + 1)),
    };
  });
  const oauth = hasOAuthContext(pairs.map((pair) => pair.name));
  return pairs
    .map((pair) => {
      if (!pair.value || !isSecretParameter(pair.name, pair.value, oauth)) return pair.raw;
      if (counts) counts.parameters += 1;
      return `${pair.rawName}=${encodeURIComponent(placeholders.replace(pair.value))}`;
    })
    .join("&");
}

function sanitizeUrl(
  url: string,
  placeholders: Placeholders,
  counts: RedactionCounts | null,
): string {
  const question = url.indexOf("?");
  if (question < 0) return url;
  const hash = url.indexOf("#", question);
  const query = hash < 0 ? url.slice(question + 1) : url.slice(question + 1, hash);
  const fragment = hash < 0 ? "" : url.slice(hash);
  return `${url.slice(0, question + 1)}${sanitizeFormPairs(query, placeholders, counts)}${fragment}`;
}

function sanitizeBody(
  text: string,
  mimeType: string,
  placeholders: Placeholders,
  counts: RedactionCounts,
  isRequest: boolean,
): string {
  const type = mimeType.toLowerCase();
  const json = sanitizeJsonText(text, placeholders, counts, type.includes("json"));
  if (json !== null) return json;
  // Non-JSON response bodies get only S3 and S4.
  if (!isRequest) return text;
  if (type.includes("multipart/form-data")) {
    return text.replace(
      /(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g,
      (match, head: string, name: string, value: string) => {
        if (!value || !isSecretParameter(name, value, false)) return match;
        counts.parameters += 1;
        return `${head}${placeholders.replace(value)}`;
      },
    );
  }
  if (type.includes("x-www-form-urlencoded") || (!type && /^[^=&\s]+=[^&\s]*(&|$)/.test(text))) {
    return sanitizeFormPairs(text, placeholders, counts);
  }
  return text;
}

/** The JSON text with secret fields replaced; null when it is not JSON. Unchanged text stays as sent. */
function sanitizeJsonText(
  text: string,
  placeholders: Placeholders,
  counts: RedactionCounts,
  declaredJson = false,
): string | null {
  if (!declaredJson && !/^\s*[[{]/.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let changed = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const oauth = hasOAuthContext(Object.keys(object));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      if (
        (typeof child === "string" || typeof child === "number") &&
        String(child).length > 0 &&
        isSecretParameter(key, String(child), oauth)
      ) {
        result[key] = placeholders.replace(String(child));
        counts.bodyFields += 1;
        changed = true;
      } else {
        result[key] = visit(child);
      }
    }
    return result;
  };
  const sanitized = visit(parsed);
  return changed ? JSON.stringify(sanitized) : text;
}

function propagationPattern(
  values: Map<string, string>,
): { pattern: RegExp; placeholders: Map<string, string> } | null {
  const needles = new Map<string, string>();
  for (const [value, placeholder] of values) {
    needles.set(value, placeholder);
    const encoded = encodeURIComponent(value);
    needles.set(encoded, placeholder);
    needles.set(encoded.replace(/%20/g, "+"), placeholder);
  }
  if (needles.size === 0) return null;
  const alternatives = [...needles.keys()]
    .sort((left, right) => right.length - left.length)
    .map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { pattern: new RegExp(alternatives.join("|"), "g"), placeholders: needles };
}

function mapStrings(value: unknown, transform: (text: string) => string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === "string") value[index] = transform(child);
      else mapStrings(child, transform);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === "string") object[key] = transform(child);
    else mapStrings(child, transform);
  }
}
