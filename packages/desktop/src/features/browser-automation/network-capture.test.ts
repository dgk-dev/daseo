import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHARS,
  MAX_CAPTURED_REQUESTS,
  MAX_LIST_BODY_CHARS,
  MAX_SNAPSHOT_BODY_BYTES,
  MAX_SNAPSHOT_BUDGET_BYTES,
  MAX_STREAM_MESSAGE_CHARS,
  NetworkCaptureBuffer,
  REDACTED,
  TabNetworkCapture,
  isSecretFieldName,
  listResponseHeaders,
  redactCredentialHeader,
  redactRequestBody,
  utf8Head,
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
    // The captured fetch's body is copied when it finishes (delta 99); the early one is not seen.
    expect(commands.map(([method, params]) => [method, params?.requestId])).toEqual([
      ["Network.enable", undefined],
      ["Network.getResponseBody", "a"],
      ["Network.disable", undefined],
    ]);
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

describe("capture enrichment for export (delta 99)", () => {
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
  const listAll = (capture: TabNetworkCapture) =>
    capture.list({
      maxEntries: 200,
      includeBodies: true,
      includeRequestBodies: true,
      includeResponseHeaders: true,
    });

  it("costs no CDP command when capture is off, even with an idle watcher fed every event", async () => {
    const { capture, commands } = captureWith({});
    const tracker = await capture.trackInflightRequests();
    deliver(capture, [
      sent("a"),
      ["Network.requestWillBeSentExtraInfo", { requestId: "a", headers: { cookie: "s=1" } }],
      received("a"),
      ["Network.dataReceived", { requestId: "a", dataLength: 10 }],
      finished("a"),
      ["Network.webSocketCreated", { requestId: "ws", url: "wss://shop.test/ws" }],
      [
        "Network.webSocketFrameReceived",
        { requestId: "ws", timestamp: 101, response: { opcode: 1, payloadData: "hi" } },
      ],
    ]);
    await tracker.release();

    expect(commands.map(([method]) => method)).toEqual(["Network.enable", "Network.disable"]);
    await capture.start();
    expect((await capture.exportData()).completed).toEqual([]);
  });

  it("copies API bodies at loadingFinished, so they survive the page navigating away", async () => {
    let navigated = false;
    const { capture, commands } = captureWith({
      "Network.getResponseBody": (params) => {
        if (navigated) throw new Error("No resource with given identifier found");
        return { body: `{"id":"${String(params.requestId)}"}`, base64Encoded: false };
      },
    });
    await capture.start();
    deliver(capture, [
      sent("api", { type: "XHR" }),
      received("api"),
      finished("api"),
      sent("css", { type: "Stylesheet" }),
      received("css", 200, "text/css"),
      finished("css"),
    ]);
    await capture.list({ maxEntries: 1, includeBodies: false, includeRequestBodies: false });
    navigated = true;

    const { entries } = await listAll(capture);
    expect(entries.map((entry) => entry.responseBody ?? entry.responseBodyUnavailable)).toEqual([
      '{"id":"api"}',
      "evicted",
    ]);
    // The stylesheet was not copied eagerly: its one getResponseBody is the list's own.
    expect(
      commands.filter(([method]) => method === "Network.getResponseBody").map(([, p]) => p),
    ).toEqual([{ requestId: "api" }, { requestId: "css" }]);
  });

  it("joins ExtraInfo that comes before, after, or never, by redirect hop", async () => {
    const { capture } = captureWith({});
    await capture.start();
    deliver(capture, [
      // Hop 0's ExtraInfo arrives before its basic event.
      [
        "Network.requestWillBeSentExtraInfo",
        { requestId: "r", headers: { Cookie: "sid=abc", Host: "shop.test" } },
      ],
      sent("r", { url: "https://shop.test/login", headers: { Accept: "text/html" } }),
      sent("r", {
        url: "https://shop.test/home",
        headers: { Accept: "*/*" },
        redirectResponse: {
          status: 302,
          statusText: "Found",
          headers: { Location: "/home" },
          protocol: "h2",
          timing: { requestTime: 100, sendStart: 1, sendEnd: 2, receiveHeadersEnd: 5 },
        },
      }),
      // Hop 0's response ExtraInfo arrives late, after hop 1 started.
      [
        "Network.responseReceivedExtraInfo",
        {
          requestId: "r",
          headers: { location: "/home", "set-cookie": "sid=new; HttpOnly" },
          headersText: "HTTP/1.1 302 Found\r\nlocation: /home\r\n\r\n",
        },
      ],
      [
        "Network.responseReceived",
        {
          requestId: "r",
          type: "Document",
          timestamp: 100.3,
          response: {
            status: 200,
            statusText: "OK",
            mimeType: "text/html",
            headers: { "content-type": "text/html", "x-page": "2" },
            remoteIPAddress: "127.0.0.1",
            remotePort: 443,
          },
        },
      ],
      ["Network.dataReceived", { requestId: "r", dataLength: 7 }],
      ["Network.loadingFinished", { requestId: "r", timestamp: 100.4, encodedDataLength: 300 }],
    ]);
    const { completed } = await capture.exportData();
    expect(
      completed.map((record) => ({
        hop: record.hop,
        wire: record.wireRequestHeaders,
        response: record.responseHeaders,
        status: record.status,
        headersSize: record.responseHeadersSize,
      })),
    ).toEqual([
      {
        hop: 0,
        wire: { Cookie: "sid=abc", Host: "shop.test" },
        response: { location: "/home", "set-cookie": "sid=new; HttpOnly" },
        status: 302,
        headersSize: 39,
      },
      // Hop 1 never got ExtraInfo: the request's and response's own headers stand.
      {
        hop: 1,
        wire: { Accept: "*/*" },
        response: { "content-type": "text/html", "x-page": "2" },
        status: 200,
        headersSize: undefined,
      },
    ]);
    expect(completed[1]).toMatchObject({
      cdpType: "document",
      remoteIPAddress: "127.0.0.1",
      decodedBodyLength: 7,
      encodedDataLength: 300,
    });
  });

  it("keeps the head of a body over 2 MiB and marks it cut", async () => {
    const big = `${"é".repeat(MAX_SNAPSHOT_BODY_BYTES / 2)}tail`;
    const { capture } = captureWith({
      "Network.getResponseBody": () => ({ body: big, base64Encoded: false }),
    });
    await capture.start();
    deliver(capture, [sent("big"), received("big"), finished("big")]);
    const [record] = (await capture.exportData()).completed;

    expect(record?.responseBody).toMatchObject({
      keptBytes: MAX_SNAPSHOT_BODY_BYTES,
      totalBytes: MAX_SNAPSHOT_BODY_BYTES + 4,
      truncated: true,
    });
    expect(record?.responseBody?.text.endsWith("é")).toBe(true);
  });

  it("marks a base64 body binary unless it is valid UTF-8 text", async () => {
    const { capture } = captureWith({
      "Network.getResponseBody": (params) =>
        params.requestId === "text"
          ? { body: Buffer.from('{"a":"ü"}').toString("base64"), base64Encoded: true }
          : { body: Buffer.from([0xff, 0xfe, 0x00]).toString("base64"), base64Encoded: true },
    });
    await capture.start();
    deliver(capture, [
      sent("text"),
      received("text"),
      finished("text"),
      sent("bad"),
      received("bad", 200, "application/json"),
      finished("bad"),
    ]);
    const [text, bad] = (await capture.exportData()).completed;

    expect(text?.responseBody?.text).toBe('{"a":"ü"}');
    expect(bad).toMatchObject({ responseBodyUnavailable: "binary" });
  });

  it("drops the oldest kept bodies past the tab budget and marks them", async () => {
    const body = "x".repeat(MAX_SNAPSHOT_BODY_BYTES);
    const { capture } = captureWith({
      "Network.getResponseBody": () => ({ body, base64Encoded: false }),
    });
    await capture.start();
    const count = MAX_SNAPSHOT_BUDGET_BYTES / MAX_SNAPSHOT_BODY_BYTES + 2;
    for (let index = 0; index < count; index += 1) {
      deliver(capture, [sent(`r${index}`), received(`r${index}`), finished(`r${index}`)]);
    }
    const { completed } = await capture.exportData();

    expect(completed.slice(0, 2).map((record) => record.responseBodyUnavailable)).toEqual([
      "budget",
      "budget",
    ]);
    expect(
      completed.slice(2).every((record) => record.responseBody?.keptBytes === body.length),
    ).toBe(true);
  });

  it("fetches a request body Chromium left out of the event at once", async () => {
    let navigated = false;
    const { capture } = captureWith({
      "Network.getRequestPostData": () => {
        if (navigated) throw new Error("gone");
        return { postData: '{"password":"hunter22","sku":"A"}' };
      },
    });
    await capture.start();
    deliver(capture, [
      sent("p", {
        method: "POST",
        hasPostData: true,
        headers: { "content-type": "application/json" },
      }),
    ]);
    await capture.list({ maxEntries: 1, includeBodies: false, includeRequestBodies: false });
    navigated = true;
    deliver(capture, [finished("p")]);

    const { entries } = await listAll(capture);
    expect(entries[0]?.requestBody).toBe(`{"password":"${REDACTED}","sku":"A"}`);
  });

  it("keeps the first and last 100 frames of a socket, binary frames by length", async () => {
    const { capture } = captureWith({});
    await capture.start();
    deliver(capture, [
      ["Network.webSocketCreated", { requestId: "ws", url: "wss://shop.test/live" }],
      [
        "Network.webSocketWillSendHandshakeRequest",
        {
          requestId: "ws",
          timestamp: 200,
          wallTime: 1_700_000_100,
          request: { headers: { Cookie: "sid=1" } },
        },
      ],
      [
        "Network.webSocketHandshakeResponseReceived",
        {
          requestId: "ws",
          timestamp: 200.01,
          response: { status: 101, statusText: "Switching Protocols", headers: { upgrade: "x" } },
        },
      ],
    ]);
    for (let index = 0; index < 250; index += 1) {
      deliver(capture, [
        [
          index % 2 === 0 ? "Network.webSocketFrameSent" : "Network.webSocketFrameReceived",
          {
            requestId: "ws",
            timestamp: 201 + index,
            response: { opcode: 1, payloadData: `m${index}` },
          },
        ],
      ]);
    }
    deliver(capture, [
      [
        "Network.webSocketFrameReceived",
        {
          requestId: "ws",
          timestamp: 500,
          response: { opcode: 2, payloadData: Buffer.from("abcdef").toString("base64") },
        },
      ],
      [
        "Network.webSocketFrameSent",
        {
          requestId: "ws",
          timestamp: 501,
          response: { opcode: 1, payloadData: "y".repeat(MAX_STREAM_MESSAGE_CHARS + 5) },
        },
      ],
    ]);
    const [socket] = (await capture.exportData()).webSockets;
    const messages = socket?.frames.messages ?? [];

    expect(messages).toHaveLength(200);
    expect(socket?.frames.dropped).toBe(52);
    expect(messages[0]).toMatchObject({ type: "send", data: "m0", time: 1_700_000_101 });
    expect(messages[99]?.data).toBe("m99");
    expect(messages.at(-2)).toMatchObject({ opcode: 2, data: "", binaryBytes: 6 });
    expect(messages.at(-1)).toMatchObject({ totalChars: MAX_STREAM_MESSAGE_CHARS + 5 });
    expect(messages.at(-1)?.data).toHaveLength(MAX_STREAM_MESSAGE_CHARS);
    expect(socket?.requestHeaders).toEqual({ Cookie: "sid=1" });
  });

  it("collects EventSource messages on the open stream", async () => {
    const { capture } = captureWith({});
    await capture.start();
    deliver(capture, [
      sent("es", { type: "EventSource" }),
      received("es", 200, "text/event-stream"),
      [
        "Network.eventSourceMessageReceived",
        { requestId: "es", timestamp: 100.5, eventName: "tick", eventId: "1", data: '{"n":1}' },
      ],
      sent("pending"),
    ]);
    const view = await capture.exportData();

    expect(view.open.map((record) => record.requestId)).toEqual(["es"]);
    expect(view.pendingCount).toBe(1);
    expect(view.open[0]?.eventSourceMessages?.messages).toEqual([
      {
        time: 1_700_000_000.5,
        eventName: "tick",
        eventId: "1",
        data: '{"n":1}',
        bytes: 7,
      },
    ]);
  });

  it("lists response headers with credentials redacted when asked", async () => {
    const { capture } = captureWith({});
    await capture.start();
    deliver(capture, [
      sent("h"),
      [
        "Network.responseReceived",
        {
          requestId: "h",
          response: {
            status: 200,
            headers: { "x-total-count": "42", "set-cookie": "sid=s3cret; Path=/\nlang=ko" },
          },
        },
      ],
      finished("h"),
    ]);
    const plain = await capture.list({
      maxEntries: 1,
      includeBodies: false,
      includeRequestBodies: false,
    });
    const withHeaders = await listAll(capture);

    expect(plain.entries[0]).not.toHaveProperty("responseHeaders");
    expect(withHeaders.entries[0]?.responseHeaders).toEqual({
      "x-total-count": "42",
      "set-cookie": `sid=${REDACTED}; Path=/\nlang=${REDACTED}`,
    });
  });

  it("start clears kept bodies, sockets, and streams", async () => {
    const { capture } = captureWith({
      "Network.getResponseBody": () => ({ body: "{}", base64Encoded: false }),
    });
    await capture.start();
    deliver(capture, [
      sent("a"),
      received("a"),
      finished("a"),
      ["Network.webSocketCreated", { requestId: "ws", url: "wss://shop.test/ws" }],
    ]);
    await capture.start();
    const view = await capture.exportData();

    expect([view.completed.length, view.webSockets.length, view.pendingCount]).toEqual([0, 0, 0]);
  });
});

describe("credential header rule S1", () => {
  const replace = (secret: string) => `[${secret}]`;

  it("keeps the scheme word, cookie names, and Set-Cookie attributes", () => {
    expect(redactCredentialHeader("Authorization", "Bearer abc.def", replace)).toBe(
      "Bearer [abc.def]",
    );
    expect(redactCredentialHeader("Proxy-Authorization", "opaque", replace)).toBe("[opaque]");
    expect(redactCredentialHeader("cookie", "a=1; b=two; flag", replace)).toBe(
      "a=[1]; b=[two]; [flag]",
    );
    expect(redactCredentialHeader("Set-Cookie", "sid=xyz; Path=/; HttpOnly; Secure", replace)).toBe(
      "sid=[xyz]; Path=/; HttpOnly; Secure",
    );
    expect(redactCredentialHeader("X-Session-Id", "s-1", replace)).toBe("[s-1]");
    expect(redactCredentialHeader("x-goog-api-key", "k", replace)).toBe("[k]");
  });

  it("leaves ordinary headers and the WWW-Authenticate challenge alone", () => {
    for (const name of ["content-type", "www-authenticate", "x-request-id", "sec-websocket-key"]) {
      expect(redactCredentialHeader(name, "v", replace), name).toBeNull();
    }
    expect(listResponseHeaders({ "WWW-Authenticate": 'Bearer realm="api"' })).toEqual({
      "WWW-Authenticate": 'Bearer realm="api"',
    });
  });
});

describe("utf8Head", () => {
  it("cuts at a character boundary and reports both lengths", () => {
    expect(utf8Head("aé", 2)).toEqual({ text: "a", keptBytes: 1, totalBytes: 3, truncated: true });
    expect(utf8Head("aé", 3)).toEqual({
      text: "aé",
      keptBytes: 3,
      totalBytes: 3,
      truncated: false,
    });
  });
});
