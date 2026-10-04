import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHARS,
  MAX_CAPTURED_REQUESTS,
  MAX_LIST_BODY_CHARS,
  NetworkCaptureBuffer,
  REDACTED,
  TabNetworkCapture,
  isSecretFieldName,
  redactRequestBody,
} from "./network-capture.js";

function sent(
  requestId: string,
  input: {
    url?: string;
    method?: string;
    type?: string;
    headers?: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
    timestamp?: number;
    redirectResponse?: Record<string, unknown>;
  } = {},
): [string, Record<string, unknown>] {
  return [
    "Network.requestWillBeSent",
    {
      requestId,
      request: {
        url: input.url ?? `https://shop.test/api/${requestId}`,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        ...(input.postData !== undefined ? { postData: input.postData } : {}),
        ...(input.hasPostData ? { hasPostData: true } : {}),
      },
      type: input.type ?? "Fetch",
      timestamp: input.timestamp ?? 100,
      wallTime: 1_700_000_000,
      ...(input.redirectResponse ? { redirectResponse: input.redirectResponse } : {}),
    },
  ];
}

const received = (requestId: string, status = 200, mimeType = "application/json") =>
  ["Network.responseReceived", { requestId, response: { status, mimeType } }] as [
    string,
    Record<string, unknown>,
  ];
const finished = (requestId: string, timestamp = 100.25) =>
  ["Network.loadingFinished", { requestId, timestamp }] as [string, Record<string, unknown>];

function feed(buffer: NetworkCaptureBuffer, events: Array<[string, Record<string, unknown>]>) {
  for (const [method, params] of events) buffer.handleEvent(method, params);
}

describe("NetworkCaptureBuffer", () => {
  it("numbers requests in completion order and pages with the cursor", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [
      sent("a"),
      sent("b"),
      received("b"),
      finished("b"),
      received("a"),
      finished("a"),
    ]);

    const first = buffer.list({ maxEntries: 1 });
    expect(first.entries.map((entry) => [entry.seq, entry.requestId])).toEqual([[1, "b"]]);
    expect(first).toMatchObject({ cursor: 1, hasMore: true, pendingCount: 0 });

    const next = buffer.list({ maxEntries: 10, since: first.cursor });
    expect(next.entries.map((entry) => entry.requestId)).toEqual(["a"]);
    expect(next).toMatchObject({ cursor: 2, hasMore: false });
    expect(buffer.list({ maxEntries: 10, since: 2 })).toMatchObject({ entries: [], cursor: 2 });
  });

  it("keeps in-flight requests out of the list until they complete", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [sent("poll"), sent("done"), finished("done")]);

    expect(buffer.list({ maxEntries: 10 })).toMatchObject({
      entries: [{ requestId: "done" }],
      pendingCount: 1,
    });
  });

  it("records status, mime type, duration, grouped type, and failures", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [
      sent("ok", { method: "post", type: "XHR" }),
      received("ok", 201),
      finished("ok", 100.5),
      sent("doc", { type: "Document" }),
      finished("doc"),
      sent("img", { type: "Image" }),
      ["Network.loadingFailed", { requestId: "img", timestamp: 101, errorText: "net::ERR_FAILED" }],
      sent("gone"),
      ["Network.loadingFailed", { requestId: "gone", canceled: true }],
    ]);

    const [ok, doc, img, gone] = buffer.list({ maxEntries: 10 }).entries;
    expect(ok).toMatchObject({
      method: "POST",
      resourceType: "xhr",
      status: 201,
      mimeType: "application/json",
      durationMs: 500,
      startedAt: 1_700_000_000_000,
    });
    expect(doc?.resourceType).toBe("document");
    expect(img).toMatchObject({ resourceType: "other", failed: "net::ERR_FAILED" });
    expect(gone?.failed).toBe("canceled");
  });

  it("filters by URL, method, and resource type", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [
      sent("cart", { method: "POST", url: "https://shop.test/api/cart" }),
      finished("cart"),
      sent("page", { type: "Document", url: "https://shop.test/cart" }),
      finished("page"),
      sent("list", { url: "https://shop.test/api/items" }),
      finished("list"),
    ]);

    const ids = (filter: Parameters<NetworkCaptureBuffer["list"]>[0]) =>
      buffer.list(filter).entries.map((entry) => entry.requestId);
    expect(ids({ maxEntries: 10, urlIncludes: "/api/" })).toEqual(["cart", "list"]);
    expect(ids({ maxEntries: 10, method: "post" })).toEqual(["cart"]);
    expect(ids({ maxEntries: 10, resourceType: "document" })).toEqual(["page"]);
  });

  it("completes a redirect hop and follows the new one under the same request id", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [
      sent("r", { url: "https://shop.test/login" }),
      sent("r", {
        url: "https://shop.test/home",
        redirectResponse: { status: 302, mimeType: "text/html" },
      }),
      received("r"),
      finished("r"),
    ]);

    expect(
      buffer
        .list({ maxEntries: 10 })
        .entries.map((entry) => [entry.url, entry.status, entry.redirected]),
    ).toEqual([
      ["https://shop.test/login", 302, true],
      ["https://shop.test/home", 200, false],
    ]);
  });

  it("drops the oldest completed requests past the cap and counts them", () => {
    const buffer = new NetworkCaptureBuffer();
    for (let index = 0; index < MAX_CAPTURED_REQUESTS + 3; index += 1) {
      feed(buffer, [sent(`r${index}`), finished(`r${index}`)]);
    }

    const listing = buffer.list({ maxEntries: 1 });
    expect(listing.entries[0]).toMatchObject({ seq: 4, requestId: "r3" });
    expect(listing.droppedCount).toBe(3);
  });

  it("keeps page headers, drops browser-managed ones, and redacts credentials", () => {
    const buffer = new NetworkCaptureBuffer();
    feed(buffer, [
      sent("h", {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-1",
          Authorization: "Bearer secret",
          Cookie: "sid=1",
          "User-Agent": "Chrome",
          "sec-ch-ua": '"Chromium"',
          Referer: "https://shop.test/",
        },
      }),
      finished("h"),
    ]);

    expect(buffer.list({ maxEntries: 1 }).entries[0]?.requestHeaders).toEqual({
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-1",
      Authorization: REDACTED,
      Cookie: REDACTED,
    });
  });
});

describe("request body redaction", () => {
  it("redacts password and one-time-code fields in JSON, forms, and multipart bodies", () => {
    expect(
      JSON.parse(
        redactRequestBody(
          JSON.stringify({ user: { id: "ada", password: "pw1" }, otp: "123456", qty: 2 }),
          "application/json",
        ),
      ),
    ).toEqual({ user: { id: "ada", password: REDACTED }, otp: REDACTED, qty: 2 });
    expect(
      redactRequestBody(
        "login_id=ada&login_pw=pw1&member_passwd=pw2",
        "application/x-www-form-urlencoded",
      ),
    ).toBe("login_id=ada&login_pw=%3Credacted%3E&member_passwd=%3Credacted%3E");
    const multipart = [
      "--b",
      'Content-Disposition: form-data; name="userPassword"',
      "",
      "pw1",
      "--b",
      'Content-Disposition: form-data; name="note"',
      "",
      "hello",
      "--b--",
    ].join("\r\n");
    const redacted = redactRequestBody(multipart, "multipart/form-data; boundary=b");
    expect(redacted).toContain(`name="userPassword"\r\n\r\n${REDACTED}`);
    expect(redacted).toContain('name="note"\r\n\r\nhello');
  });

  it("leaves bodies without secret fields unchanged", () => {
    expect(redactRequestBody("q=shoes&page=2", undefined)).toBe("q=shoes&page=2");
    expect(redactRequestBody("plain text", "text/plain")).toBe("plain text");
  });

  it("matches credential field names without catching ordinary ones", () => {
    for (const name of [
      "password",
      "new_password",
      "userPwd",
      "login_pw",
      "passwd",
      "pin",
      "totp",
      "mfa_code",
      "smsOtp",
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
    for (const name of ["footprint", "user_id", "author", "code", "token_type", "passenger"]) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });
});

describe("TabNetworkCapture", () => {
  function captureWith(responses: Record<string, (params: Record<string, unknown>) => unknown>) {
    const commands: Array<[string, Record<string, unknown> | undefined]> = [];
    const capture = new TabNetworkCapture({
      sendCommand: async (method, params) => {
        commands.push([method, params]);
        const respond = responses[method];
        if (!respond) return {};
        return respond(params ?? {});
      },
    });
    return { capture, commands };
  }

  const deliver = (
    capture: TabNetworkCapture,
    events: Array<[string, Record<string, unknown>]>,
  ) => {
    for (const [method, params] of events) capture.handleDebuggerMessage(method, params);
  };

  it("ignores events until started and disables the domain on stop", async () => {
    const { capture, commands } = captureWith({});
    deliver(capture, [sent("early"), finished("early")]);
    await capture.start();
    deliver(capture, [sent("a"), finished("a")]);

    expect(
      (await capture.list({ maxEntries: 10, includeBodies: false, includeRequestBodies: false }))
        .entries,
    ).toHaveLength(1);
    await capture.stop();
    expect(capture.capturing).toBe(false);
    expect(commands.map(([method]) => method)).toEqual(["Network.enable", "Network.disable"]);
  });

  it("stops when the debugger detaches", async () => {
    const { capture } = captureWith({});
    await capture.start();
    capture.handleDebuggerDetached();

    expect(capture.capturing).toBe(false);
  });

  it("counts requests in flight for an idle watcher without buffering them", async () => {
    const { capture, commands } = captureWith({});
    const tracker = await capture.trackInflightRequests();
    deliver(capture, [sent("a"), sent("b"), sent("b", { redirectResponse: { status: 302 } })]);
    expect(tracker.inflight()).toBe(2);
    deliver(capture, [finished("a"), ["Network.loadingFailed", { requestId: "b" }]]);
    expect(tracker.inflight()).toBe(0);
    expect(capture.capturing).toBe(false);

    await tracker.release();
    expect(commands.map(([method]) => method)).toEqual(["Network.enable", "Network.disable"]);
  });

  it("keeps the domain on for a running capture or another watcher", async () => {
    const { capture, commands } = captureWith({});
    await capture.start();
    const first = await capture.trackInflightRequests();
    const second = await capture.trackInflightRequests();
    await capture.stop();
    await first.release();
    expect(commands.map(([method]) => method)).toEqual(["Network.enable"]);

    deliver(capture, [sent("late")]);
    expect(second.inflight()).toBe(1);
    await second.release();
    expect(commands.map(([method]) => method)).toEqual(["Network.enable", "Network.disable"]);
  });

  it("tells an idle watcher when the debugger detached under it", async () => {
    const { capture } = captureWith({});
    const tracker = await capture.trackInflightRequests();
    deliver(capture, [sent("a")]);
    capture.handleDebuggerDetached();

    expect(tracker.lost()).toBe(true);
    expect(tracker.inflight()).toBe(0);
  });

  it("fetches bodies on demand, decodes text, and explains missing ones", async () => {
    const { capture } = captureWith({
      "Network.getResponseBody": (params) => {
        if (params.requestId === "json") return { body: '{"ok":true}', base64Encoded: false };
        if (params.requestId === "b64")
          return { body: Buffer.from("héllo").toString("base64"), base64Encoded: true };
        if (params.requestId === "png") return { body: "iVBORw0K", base64Encoded: true };
        throw new Error("No resource with given identifier found");
      },
      "Network.getRequestPostData": () => ({ postData: '{"password":"pw1","sku":"A"}' }),
    });
    await capture.start();
    deliver(capture, [
      sent("json", {
        method: "POST",
        postData: '{"qty":1}',
        headers: { "Content-Type": "application/json" },
      }),
      received("json"),
      finished("json"),
      sent("b64"),
      received("b64", 200, "text/plain"),
      finished("b64"),
      sent("png"),
      received("png", 200, "image/png"),
      finished("png"),
      sent("evicted"),
      finished("evicted"),
      sent("big", {
        method: "POST",
        hasPostData: true,
        headers: { "content-type": "application/json" },
      }),
      finished("big"),
    ]);

    const { entries } = await capture.list({
      maxEntries: 10,
      includeBodies: true,
      includeRequestBodies: true,
    });
    expect(
      entries.map((entry) => [
        entry.url.split("/").at(-1),
        entry.responseBody ?? entry.responseBodyUnavailable,
      ]),
    ).toEqual([
      ["json", '{"ok":true}'],
      ["b64", "héllo"],
      ["png", "binary"],
      ["evicted", "evicted"],
      ["big", "evicted"],
    ]);
    expect(entries[0]?.requestBody).toBe('{"qty":1}');
    expect(entries[4]?.requestBody).toBe(`{"password":"${REDACTED}","sku":"A"}`);
    expect(entries[1]?.requestBody).toBeUndefined();
  });

  it("caps each body and the total returned by one list", async () => {
    const big = "x".repeat(MAX_BODY_CHARS + 10);
    const { capture } = captureWith({
      "Network.getResponseBody": () => ({ body: big, base64Encoded: false }),
    });
    await capture.start();
    const count = Math.ceil(MAX_LIST_BODY_CHARS / MAX_BODY_CHARS) + 1;
    for (let index = 0; index < count; index += 1) {
      deliver(capture, [
        sent(`r${index}`),
        received(`r${index}`, 200, "text/plain"),
        finished(`r${index}`),
      ]);
    }

    const { entries } = await capture.list({
      maxEntries: 50,
      includeBodies: true,
      includeRequestBodies: false,
    });
    expect(entries[0]).toMatchObject({ responseBodyTruncated: true });
    expect(entries[0]?.responseBody).toHaveLength(MAX_BODY_CHARS);
    expect(entries.at(-1)?.responseBodyUnavailable).toBe("budget");
    const total = entries.reduce((sum, entry) => sum + (entry.responseBody?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_LIST_BODY_CHARS);
  });
});
