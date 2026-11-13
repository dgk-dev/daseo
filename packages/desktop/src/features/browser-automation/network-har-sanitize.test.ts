import { describe, expect, it } from "vitest";
import type { Har, HarEntry } from "./network-har.js";
import { SANITIZE_RULES_VERSION, isSecretParameter, sanitizeHar } from "./network-har-sanitize.js";

const BEARER = "tok_live_9f8e7d6c5b4a";
const SESSION = "sess-0123456789abcdef";
const PASSWORD = "correct horse battery";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEiLCJlbWFpbCI6ImFkYUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJlLWJ5dGVz";

function entry(input: {
  url?: string;
  method?: string;
  requestHeaders?: Array<[string, string]>;
  responseHeaders?: Array<[string, string]>;
  postData?: { mimeType: string; text: string };
  responseText?: string;
  responseMimeType?: string;
  redirectURL?: string;
  webSocket?: string[];
}): HarEntry {
  const url = input.url ?? "https://api.shop.test/v1/items";
  const parsed = new URL(url);
  const headers = (pairs: Array<[string, string]> = []) =>
    pairs.map(([name, value]) => ({ name, value }));
  return {
    startedDateTime: "2026-11-13T00:00:00.000Z",
    time: 1,
    request: {
      method: input.method ?? "GET",
      url,
      httpVersion: "http/2.0",
      cookies: (input.requestHeaders ?? [])
        .filter(([name]) => name.toLowerCase() === "cookie")
        .flatMap(([, value]) =>
          value.split("; ").map((pair) => {
            const [name = "", cookieValue = ""] = pair.split("=");
            return { name, value: cookieValue };
          }),
        ),
      headers: headers(input.requestHeaders),
      queryString: [...parsed.searchParams].map(([name, value]) => ({ name, value })),
      ...(input.postData ? { postData: input.postData } : {}),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "http/2.0",
      cookies: (input.responseHeaders ?? [])
        .filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => {
          const [pair = ""] = value.split(";");
          const [name = "", cookieValue = ""] = pair.split("=");
          return { name, value: cookieValue, path: "/", httpOnly: true };
        }),
      headers: headers(input.responseHeaders),
      content: {
        size: 0,
        mimeType: input.responseMimeType ?? "application/json",
        ...(input.responseText !== undefined ? { text: input.responseText } : {}),
      },
      redirectURL: input.redirectURL ?? "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 1, receive: 0 },
    _resourceType: "fetch",
    ...(input.webSocket
      ? {
          _webSocketMessages: input.webSocket.map((data) => ({
            type: "send" as const,
            time: 1,
            opcode: 1,
            data,
          })),
        }
      : {}),
    _daseo: { seq: 1 },
  };
}

function har(...entries: HarEntry[]): Har {
  return {
    log: {
      version: "1.2",
      creator: { name: "Daseo", version: "test" },
      browser: { name: "Chromium", version: "test" },
      entries,
    },
  };
}

const header = (target: HarEntry, side: "request" | "response", name: string) =>
  target[side].headers.filter((item) => item.name.toLowerCase() === name).map((item) => item.value);

describe("sanitizeHar", () => {
  it("S1: keeps header names, the scheme word, cookie names, and Set-Cookie attributes", () => {
    const { har: sanitized, redactions } = sanitizeHar(
      har(
        entry({
          requestHeaders: [
            ["Authorization", `Bearer ${BEARER}`],
            ["Cookie", `sid=${SESSION}; lang=ko`],
            ["X-CSRF-Token", "csrf-abcdefgh-1234"],
            ["X-Api-Key", "k1"],
            ["Accept", "application/json"],
          ],
          responseHeaders: [
            ["Set-Cookie", `sid=${SESSION}; Path=/; HttpOnly`],
            ["WWW-Authenticate", 'Bearer realm="api"'],
            ["Content-Type", "application/json"],
          ],
        }),
      ),
    );
    const [first] = sanitized.log.entries;
    if (!first) throw new Error("no entry");

    expect(first.request.headers).toEqual([
      { name: "Authorization", value: "Bearer <redacted-1>" },
      { name: "Cookie", value: "sid=<redacted-2>; lang=<redacted>" },
      { name: "X-CSRF-Token", value: "<redacted-3>" },
      { name: "X-Api-Key", value: "<redacted>" },
      { name: "Accept", value: "application/json" },
    ]);
    expect(first.request.cookies).toEqual([
      { name: "sid", value: "<redacted-2>" },
      { name: "lang", value: "<redacted>" },
    ]);
    expect(header(first, "response", "set-cookie")).toEqual(["sid=<redacted-2>; Path=/; HttpOnly"]);
    expect(first.response.cookies).toEqual([
      { name: "sid", value: "<redacted-2>", path: "/", httpOnly: true },
    ]);
    expect(header(first, "response", "www-authenticate")).toEqual(['Bearer realm="api"']);
    expect(redactions).toMatchObject({ headers: 3, cookies: 3 });
    expect(sanitized.log._daseo).toEqual({ sanitized: true, rules: SANITIZE_RULES_VERSION });
  });

  it("S2: replaces secret query, form, multipart, and JSON values and keeps the keys", () => {
    const multipart = [
      "--b",
      'Content-Disposition: form-data; name="api_key"',
      "",
      "short",
      "--b",
      'Content-Disposition: form-data; name="note"',
      "",
      "hello",
      "--b--",
    ].join("\r\n");
    const { har: sanitized, redactions } = sanitizeHar(
      har(
        entry({ url: `https://api.shop.test/v1/me?access_token=${BEARER}&page=2&key=abc` }),
        entry({
          method: "POST",
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: `user=ada&password=${encodeURIComponent(PASSWORD)}&key=${"k".repeat(20)}`,
          },
        }),
        entry({
          method: "POST",
          postData: { mimeType: "multipart/form-data; boundary=b", text: multipart },
        }),
        entry({
          method: "POST",
          postData: {
            mimeType: "application/json",
            text: JSON.stringify({ login: { pin: 1234, id: "ada" } }),
          },
          responseText: JSON.stringify({
            data: [
              { refresh_token: "rt-0123456789", csrfToken: "c-0123456789", sig: 99, auth: true },
            ],
            name: "Ada",
          }),
        }),
      ),
    );
    const [query, form, parts, json] = sanitized.log.entries;

    expect(query?.request.url).toBe(
      "https://api.shop.test/v1/me?access_token=%3Credacted-1%3E&page=2&key=abc",
    );
    expect(query?.request.queryString).toEqual([
      { name: "access_token", value: "<redacted-1>" },
      { name: "page", value: "2" },
      { name: "key", value: "abc" },
    ]);
    expect(form?.request.postData?.text).toBe(
      "user=ada&password=%3Credacted-2%3E&key=%3Credacted-3%3E",
    );
    expect(parts?.request.postData?.text).toContain('name="api_key"\r\n\r\n<redacted>\r\n');
    expect(parts?.request.postData?.text).toContain('name="note"\r\n\r\nhello');
    expect(JSON.parse(json?.request.postData?.text ?? "null")).toEqual({
      login: { pin: "<redacted>", id: "ada" },
    });
    expect(JSON.parse(json?.response.content.text ?? "null")).toEqual({
      data: [
        { refresh_token: "<redacted-4>", csrfToken: "<redacted-5>", sig: "<redacted>", auth: true },
      ],
      name: "Ada",
    });
    expect(redactions).toMatchObject({ parameters: 4, bodyFields: 4 });
  });

  it("S2: an OAuth code is a secret only beside state or redirect_uri", () => {
    const { har: sanitized } = sanitizeHar(
      har(
        entry({ url: "https://shop.test/callback?code=oauth-code-123456&state=xyz" }),
        entry({ url: "https://shop.test/coupons?code=WELCOME10" }),
        entry({
          method: "POST",
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fshop.test%2Fcb",
          },
        }),
      ),
    );
    const [callback, coupon, token] = sanitized.log.entries;

    expect(callback?.request.url).toBe(
      "https://shop.test/callback?code=%3Credacted-1%3E&state=xyz",
    );
    expect(coupon?.request.url).toBe("https://shop.test/coupons?code=WELCOME10");
    expect(token?.request.postData?.text).toBe(
      "grant_type=authorization_code&code=%3Credacted%3E&redirect_uri=https%3A%2F%2Fshop.test%2Fcb",
    );
  });

  it("S3: carries each placeholder to every other occurrence, URL-encoded ones too", () => {
    const issued = entry({
      method: "POST",
      url: "https://api.shop.test/v1/login",
      postData: { mimeType: "application/json", text: JSON.stringify({ password: PASSWORD }) },
      // The server echoes the password and hands out a session the page sends back later.
      responseText: `{"echo":"${PASSWORD}","session":"${SESSION}"}`,
    });
    const reused = entry({
      url: `https://api.shop.test/v1/me?s=${encodeURIComponent(SESSION)}&p=${encodeURIComponent(PASSWORD)}`,
      requestHeaders: [["X-Forwarded-Note", `pw ${PASSWORD}`]],
      responseText: `<p>Welcome back, ${SESSION}</p>`,
      responseMimeType: "text/html",
      webSocket: [`{"type":"hello","s":"${SESSION}"}`, `raw ${PASSWORD}`],
    });
    const { har: sanitized, redactions } = sanitizeHar(har(issued, reused));
    const text = JSON.stringify(sanitized);

    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(encodeURIComponent(PASSWORD));
    expect(text).not.toContain(SESSION);
    const [login, me] = sanitized.log.entries;
    expect(JSON.parse(login?.response.content.text ?? "null")).toEqual({
      echo: "<redacted-1>",
      session: "<redacted-2>",
    });
    expect(me?.request.url).toBe("https://api.shop.test/v1/me?s=<redacted-2>&p=<redacted-1>");
    expect(me?.response.content.text).toBe("<p>Welcome back, <redacted-2></p>");
    expect(me?._webSocketMessages?.map((message) => message.data)).toEqual([
      '{"type":"hello","s":"<redacted-2>"}',
      "raw <redacted-1>",
    ]);
    expect(redactions.propagated).toBeGreaterThanOrEqual(6);
  });

  it("S3: a value shorter than 8 characters is replaced where found and not propagated", () => {
    const { har: sanitized } = sanitizeHar(
      har(
        entry({
          method: "POST",
          postData: { mimeType: "application/json", text: '{"otp":"123456","order":"123456"}' },
        }),
      ),
    );

    expect(sanitized.log.entries[0]?.request.postData?.text).toBe(
      '{"otp":"<redacted>","order":"123456"}',
    );
  });

  it("S4: replaces JWT-shaped strings anywhere with one placeholder per token", () => {
    const { har: sanitized, redactions } = sanitizeHar(
      har(
        entry({
          url: `https://api.shop.test/v1/feed?t=${JWT}`,
          responseText: `{"data":{"note":"${JWT}"}}`,
          responseHeaders: [["X-Debug", `issued ${JWT}`]],
        }),
      ),
    );
    const text = JSON.stringify(sanitized);

    expect(text).not.toContain("eyJ");
    expect(sanitized.log.entries[0]?.request.url).toBe(
      "https://api.shop.test/v1/feed?t=<redacted-jwt-1>",
    );
    expect(header(sanitized.log.entries[0] as HarEntry, "response", "x-debug")).toEqual([
      "issued <redacted-jwt-1>",
    ]);
    expect(redactions.jwts).toBeGreaterThanOrEqual(4);
  });

  it("leaves a non-JSON response body to S3 and S4 and an ordinary file untouched", () => {
    const plain = entry({
      responseText: "password=visible-because-not-json",
      responseMimeType: "text/plain",
    });
    const { har: sanitized, redactions } = sanitizeHar(har(plain));

    expect(sanitized.log.entries[0]?.response.content.text).toBe(
      "password=visible-because-not-json",
    );
    expect(redactions).toEqual({
      headers: 0,
      cookies: 0,
      parameters: 0,
      bodyFields: 0,
      propagated: 0,
      jwts: 0,
    });
  });

  it("redacts query secrets in redirect targets, Location, and Referer", () => {
    const { har: sanitized } = sanitizeHar(
      har(
        entry({
          redirectURL: "https://shop.test/cb?token=abc",
          requestHeaders: [["Referer", "https://shop.test/?sid=xyz"]],
          responseHeaders: [["Location", "https://shop.test/cb?token=abc"]],
        }),
      ),
    );
    const [first] = sanitized.log.entries;

    expect(first?.response.redirectURL).toBe("https://shop.test/cb?token=%3Credacted%3E");
    expect(header(first as HarEntry, "response", "location")).toEqual([
      "https://shop.test/cb?token=%3Credacted%3E",
    ]);
    expect(header(first as HarEntry, "request", "referer")).toEqual([
      "https://shop.test/?sid=%3Credacted%3E",
    ]);
  });
});

describe("isSecretParameter", () => {
  it("covers the S2 names and leaves ordinary ones", () => {
    for (const name of [
      "access_token",
      "refresh_token",
      "id_token",
      "token",
      "client_secret",
      "api_key",
      "apikey",
      "signature",
      "sig",
      "session",
      "sessionid",
      "sid",
      "jwt",
      "auth",
      "credentials",
      "password",
      "otp",
      "X-Auth-Token",
      "csrf_token",
    ]) {
      expect(isSecretParameter(name, "v", false), name).toBe(true);
    }
    for (const name of ["page", "q", "token_type", "code", "key", "author", "session_count"]) {
      expect(isSecretParameter(name, "v", false), name).toBe(false);
    }
    expect(isSecretParameter("key", "k".repeat(16), false)).toBe(true);
    expect(isSecretParameter("code", "v", true)).toBe(true);
  });
});
