import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BODY_BYTES,
  MAX_SNAPSHOT_BUDGET_BYTES,
  TabNetworkCapture,
  type NetworkCaptureExport,
} from "./network-capture.js";
import { buildHar, describeHarExport, httpTimings, type HarBuildOptions } from "./network-har.js";

type CdpEvent = [string, Record<string, unknown>];

const WALL = 1_700_000_000;
const MAIN_FRAME = "MAIN";

function request(
  requestId: string,
  input: {
    url?: string;
    method?: string;
    type?: string;
    headers?: Record<string, string>;
    postData?: string;
    timestamp?: number;
    frameId?: string;
    redirectResponse?: Record<string, unknown>;
  } = {},
): CdpEvent {
  const timestamp = input.timestamp ?? 100;
  return [
    "Network.requestWillBeSent",
    {
      requestId,
      request: {
        url: input.url ?? `https://api.shop.test/v1/${requestId}`,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        ...(input.postData !== undefined ? { postData: input.postData } : {}),
      },
      type: input.type ?? "Fetch",
      timestamp,
      wallTime: WALL + (timestamp - 100),
      initiator: { type: "script", url: "https://shop.test/app.js", stack: { callFrames: [] } },
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.redirectResponse ? { redirectResponse: input.redirectResponse } : {}),
    },
  ];
}

function response(
  requestId: string,
  input: {
    status?: number;
    mimeType?: string;
    headers?: Record<string, string>;
    timestamp?: number;
    extra?: Record<string, unknown>;
  } = {},
): CdpEvent {
  return [
    "Network.responseReceived",
    {
      requestId,
      timestamp: input.timestamp ?? 100.05,
      response: {
        status: input.status ?? 200,
        statusText: "OK",
        mimeType: input.mimeType ?? "application/json",
        headers: input.headers ?? { "content-type": "application/json; charset=utf-8" },
        protocol: "h2",
        remoteIPAddress: "[::1]",
        remotePort: 443,
        connectionId: 7,
        ...input.extra,
      },
    },
  ];
}

const finished = (requestId: string, timestamp = 100.1, encodedDataLength = 120): CdpEvent => [
  "Network.loadingFinished",
  { requestId, timestamp, encodedDataLength },
];

async function exportOf(
  events: CdpEvent[],
  bodies: Record<string, { body: string; base64Encoded?: boolean } | "evicted"> = {},
): Promise<NetworkCaptureExport> {
  const capture = new TabNetworkCapture({
    sendCommand: async (method, params) => {
      if (method === "Network.getResponseBody") {
        const body = bodies[String(params?.requestId)];
        if (!body || body === "evicted") throw new Error("No resource with given identifier");
        return { body: body.body, base64Encoded: body.base64Encoded === true };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: MAIN_FRAME } } };
      return {};
    },
  });
  await capture.start();
  for (const [method, params] of events) capture.handleDebuggerMessage(method, params);
  return capture.exportData();
}

const OPTIONS: HarBuildOptions = {
  creatorVersion: "0.5.114",
  browserVersion: "146.0.0.0",
  bodies: "api",
  includeWebSocket: true,
};

describe("buildHar", () => {
  it("maps a plain GET with its headers, query, cookies, timings, and body", async () => {
    const data = await exportOf(
      [
        request("list", {
          url: "https://api.shop.test/v1/items?tag=a&tag=b&q=%ED%95%9C#frag",
          headers: { Accept: "application/json" },
        }),
        [
          "Network.requestWillBeSentExtraInfo",
          { requestId: "list", headers: { Accept: "application/json", Cookie: "sid=1; lang=ko" } },
        ],
        response("list", {
          headers: { "content-type": "application/json", "x-trace": "a\nb" },
          extra: {
            timing: {
              requestTime: 100.002,
              dnsStart: 1,
              dnsEnd: 3,
              connectStart: 3,
              sslStart: 5,
              sslEnd: 9,
              connectEnd: 10,
              sendStart: 11,
              sendEnd: 12,
              receiveHeadersEnd: 40,
            },
          },
        }),
        finished("list", 100.1),
      ],
      { list: { body: '{"items":[1,2]}' } },
    );
    const { har, stats } = buildHar(data, OPTIONS);
    const [entry] = har.log.entries;

    expect(har.log).toMatchObject({
      version: "1.2",
      creator: { name: "Daseo", version: "0.5.114" },
      browser: { name: "Chromium", version: "146.0.0.0" },
    });
    expect(har.log.pages).toBeUndefined();
    expect(entry?.pageref).toBeUndefined();
    expect(entry?.request).toEqual({
      method: "GET",
      url: "https://api.shop.test/v1/items?tag=a&tag=b&q=%ED%95%9C",
      httpVersion: "http/2.0",
      cookies: [
        { name: "sid", value: "1" },
        { name: "lang", value: "ko" },
      ],
      headers: [
        { name: "Accept", value: "application/json" },
        { name: "Cookie", value: "sid=1; lang=ko" },
      ],
      queryString: [
        { name: "tag", value: "a" },
        { name: "tag", value: "b" },
        { name: "q", value: "한" },
      ],
      headersSize: -1,
      bodySize: 0,
    });
    expect(entry?.response).toMatchObject({
      status: 200,
      statusText: "OK",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-trace", value: "a" },
        { name: "x-trace", value: "b" },
      ],
      content: { size: 15, mimeType: "application/json", text: '{"items":[1,2]}' },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
      _transferSize: 120,
    });
    // 2 ms queued + 1 ms before DNS; connect 3..10 holds TLS 5..9, counted once.
    expect(entry?.timings).toEqual({
      blocked: 3,
      dns: 2,
      connect: 7,
      ssl: 4,
      send: 1,
      wait: 28,
      receive: 58,
    });
    expect(entry?.time).toBe(99);
    expect(entry).toMatchObject({
      startedDateTime: new Date(WALL * 1000).toISOString(),
      serverIPAddress: "::1",
      connection: "7",
      cache: {},
      _resourceType: "fetch",
      _initiator: { type: "script", url: "https://shop.test/app.js" },
      _daseo: { seq: 1 },
    });
    expect(stats).toMatchObject({
      entries: 1,
      bodies: { embedded: 1, truncated: 0 },
      hosts: [{ host: "api.shop.test", requests: 1 }],
      window: { firstStartedAt: WALL * 1000, lastStartedAt: WALL * 1000 },
    });
  });

  it("keeps a POST's JSON body as postData text", async () => {
    const body = JSON.stringify({ sku: "A1", qty: 2 });
    const data = await exportOf([
      request("cart", {
        method: "POST",
        postData: body,
        headers: { "Content-Type": "application/json" },
      }),
      response("cart", { status: 201 }),
      finished("cart"),
    ]);
    const [entry] = buildHar(data, OPTIONS).har.log.entries;

    expect(entry?.request.postData).toEqual({ mimeType: "application/json", text: body });
    expect(entry?.request.bodySize).toBe(body.length);
    expect(entry?.response.status).toBe(201);
    expect(entry?._daseo.bodyUnavailable).toBe("evicted");
  });

  it("writes each hop of a 3-hop redirect chain as its own entry", async () => {
    const hop = (status: number, location: string) => ({
      status,
      statusText: "Found",
      mimeType: "text/html",
      headers: { location },
    });
    const data = await exportOf(
      [
        request("nav", { url: "https://shop.test/a", type: "Document", frameId: MAIN_FRAME }),
        request("nav", {
          url: "https://shop.test/b",
          type: "Document",
          frameId: MAIN_FRAME,
          timestamp: 100.1,
          redirectResponse: hop(301, "/b"),
        }),
        request("nav", {
          url: "https://shop.test/c",
          type: "Document",
          frameId: MAIN_FRAME,
          timestamp: 100.2,
          redirectResponse: hop(302, "https://shop.test/c"),
        }),
        response("nav", { mimeType: "text/html", headers: { "content-type": "text/html" } }),
        finished("nav", 100.3),
        request("api", { timestamp: 100.4 }),
        response("api"),
        finished("api", 100.5),
      ],
      { nav: { body: "<html>c</html>" }, api: { body: "{}" } },
    );
    const { har, stats } = buildHar(data, OPTIONS);

    expect(
      har.log.entries.map((entry) => [
        entry.request.url,
        entry.response.status,
        entry.response.redirectURL,
        entry._daseo.bodyUnavailable ?? entry.response.content.text,
        entry.pageref,
      ]),
    ).toEqual([
      ["https://shop.test/a", 301, "/b", "redirect", "page_1"],
      ["https://shop.test/b", 302, "https://shop.test/c", "redirect", "page_1"],
      ["https://shop.test/c", 200, "", "<html>c</html>", "page_1"],
      ["https://api.shop.test/v1/api", 200, "", "{}", "page_1"],
    ]);
    expect(har.log.pages).toEqual([
      {
        startedDateTime: new Date(WALL * 1000).toISOString(),
        id: "page_1",
        title: "https://shop.test/c",
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ]);
    expect(stats.bodies.unavailable.redirect).toBe(2);
    expect(stats.pages).toBe(1);
  });

  it("gives entries the latest page that started before them", async () => {
    const data = await exportOf([
      request("before", { timestamp: 99 }),
      finished("before", 99.1),
      request("p1", { type: "Document", frameId: MAIN_FRAME, timestamp: 100 }),
      finished("p1", 100.1),
      request("frame", { type: "Document", frameId: "CHILD", timestamp: 100.2 }),
      finished("frame", 100.3),
      request("p2", { type: "Document", frameId: MAIN_FRAME, timestamp: 101 }),
      finished("p2", 101.1),
      request("after", { timestamp: 101.5 }),
      finished("after", 101.6),
    ]);
    const { har } = buildHar(data, OPTIONS);

    expect(har.log.pages?.map((page) => page.id)).toEqual(["page_1", "page_2"]);
    expect(har.log.entries.map((entry) => entry.pageref ?? null)).toEqual([
      null,
      "page_1",
      "page_1",
      "page_2",
      "page_2",
    ]);
  });

  it("marks failed and canceled requests with status 0 and the error", async () => {
    const data = await exportOf([
      request("refused"),
      [
        "Network.loadingFailed",
        {
          requestId: "refused",
          timestamp: 100.2,
          errorText: "net::ERR_BLOCKED_BY_CLIENT",
          blockedReason: "inspector",
        },
      ],
      request("gone", { timestamp: 100.3 }),
      ["Network.loadingFailed", { requestId: "gone", timestamp: 100.4, canceled: true }],
    ]);
    const { har, stats } = buildHar(data, OPTIONS);

    expect(har.log.entries.map((entry) => entry.response)).toEqual([
      expect.objectContaining({
        status: 0,
        statusText: "",
        httpVersion: "",
        headers: [],
        cookies: [],
        _error: "net::ERR_BLOCKED_BY_CLIENT",
      }),
      expect.objectContaining({ status: 0, _error: "canceled" }),
    ]);
    expect(har.log.entries[0]?._daseo).toMatchObject({
      bodyUnavailable: "failed",
      blockedReason: "inspector",
    });
    expect(har.log.entries[0]?.timings).toMatchObject({ send: 0, wait: 200, receive: 0 });
    expect(stats.bodies.unavailable.failed).toBe(2);
  });

  it("marks a memory cache hit and gives it a zero body size", async () => {
    const data = await exportOf(
      [
        request("cached"),
        ["Network.requestServedFromCache", { requestId: "cached" }],
        response("cached"),
        finished("cached", 100.1, 0),
        request("disk", { timestamp: 100.2 }),
        response("disk", { extra: { fromDiskCache: true, fromServiceWorker: true } }),
        finished("disk", 100.3, 0),
      ],
      { cached: { body: "{}" }, disk: { body: "{}" } },
    );
    const [memory, disk] = buildHar(data, OPTIONS).har.log.entries;

    expect(memory).toMatchObject({ _fromCache: "memory", response: { bodySize: 0 } });
    expect(disk).toMatchObject({
      _fromCache: "disk",
      _fetchedViaServiceWorker: true,
      response: { bodySize: 0 },
    });
  });

  it("marks a body over the cap, a binary body, and bodies dropped by the budget", async () => {
    const big = "x".repeat(MAX_SNAPSHOT_BODY_BYTES + 10);
    const filler = "y".repeat(MAX_SNAPSHOT_BODY_BYTES);
    const events: CdpEvent[] = [
      request("old"),
      response("old"),
      finished("old"),
      request("png", { type: "Fetch" }),
      response("png", { mimeType: "image/png", headers: { "content-type": "image/png" } }),
      finished("png"),
      request("big"),
      response("big"),
      finished("big"),
    ];
    const bodies: Record<string, { body: string; base64Encoded?: boolean }> = {
      old: { body: filler },
      png: { body: "iVBORw0KGgo=", base64Encoded: true },
      big: { body: big },
    };
    for (let index = 0; index < MAX_SNAPSHOT_BUDGET_BYTES / MAX_SNAPSHOT_BODY_BYTES - 1; index++) {
      events.push(request(`f${index}`), response(`f${index}`), finished(`f${index}`));
      bodies[`f${index}`] = { body: filler };
    }
    const { har, stats } = buildHar(await exportOf(events, bodies), OPTIONS);
    const byUrl = (id: string) =>
      har.log.entries.find((entry) => entry.request.url.endsWith(`/${id}`));

    expect(byUrl("old")?._daseo.bodyUnavailable).toBe("budget");
    expect(byUrl("png")?._daseo.bodyUnavailable).toBe("binary");
    expect(byUrl("big")?._daseo.bodyTruncated).toEqual({
      keptBytes: MAX_SNAPSHOT_BODY_BYTES,
      totalBytes: MAX_SNAPSHOT_BODY_BYTES + 10,
    });
    expect(byUrl("big")?.response.content.size).toBe(MAX_SNAPSHOT_BODY_BYTES + 10);
    expect(stats.bodies).toMatchObject({
      truncated: 1,
      unavailable: { budget: 1, binary: 1, evicted: 0 },
    });
  });

  it("writes a WebSocket's kept frames and how many were dropped", async () => {
    const events: CdpEvent[] = [
      ["Network.webSocketCreated", { requestId: "ws", url: "wss://live.shop.test/socket?room=1" }],
      [
        "Network.webSocketWillSendHandshakeRequest",
        { requestId: "ws", timestamp: 100, wallTime: WALL, request: { headers: { Origin: "x" } } },
      ],
      [
        "Network.webSocketHandshakeResponseReceived",
        {
          requestId: "ws",
          timestamp: 100.02,
          response: { status: 101, statusText: "Switching Protocols", headers: { upgrade: "ws" } },
        },
      ],
    ];
    for (let index = 0; index < 205; index += 1) {
      events.push([
        "Network.webSocketFrameReceived",
        {
          requestId: "ws",
          timestamp: 101 + index,
          response: { opcode: 1, payloadData: `${index}` },
        },
      ]);
    }
    events.push(["Network.webSocketClosed", { requestId: "ws", timestamp: 400 }]);
    const { har, stats } = buildHar(await exportOf(events), OPTIONS);
    const [entry] = har.log.entries;

    expect(entry).toMatchObject({
      request: { method: "GET", url: "wss://live.shop.test/socket?room=1" },
      response: { status: 101, bodySize: 0 },
      time: 20,
      _resourceType: "websocket",
      _daseo: { framesDropped: 5 },
    });
    expect(entry?._webSocketMessages).toHaveLength(200);
    expect(entry?._webSocketMessages?.[0]).toEqual({
      type: "receive",
      time: WALL + 1,
      opcode: 1,
      data: "0",
    });
    expect(entry?._webSocketMessages?.at(-1)?.data).toBe("204");
    expect(stats.webSockets).toEqual({ sockets: 1, frames: 200, framesDropped: 5 });
    expect(
      buildHar(await exportOf(events), { ...OPTIONS, includeWebSocket: false }).stats.entries,
    ).toBe(0);
  });

  it("exports an open EventSource stream with its messages and leaves pending requests out", async () => {
    const data = await exportOf([
      request("es", { type: "EventSource" }),
      response("es", { mimeType: "text/event-stream" }),
      [
        "Network.eventSourceMessageReceived",
        { requestId: "es", timestamp: 100.5, eventName: "price", eventId: "9", data: "1200" },
      ],
      request("slow", { timestamp: 100.6 }),
    ]);
    const { har, stats } = buildHar(data, OPTIONS);

    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]).toMatchObject({
      _resourceType: "eventsource",
      _eventSourceMessages: [{ time: WALL + 0.5, eventName: "price", eventId: "9", data: "1200" }],
      _daseo: { open: true, bodyUnavailable: "not-captured" },
    });
    expect(har.log.entries[0]?._daseo.seq).toBeUndefined();
    expect(stats.pendingCount).toBe(1);
    expect(describeHarExport(stats, { headers: 0 }, "api")).toContain(
      "1 requests still in flight at export are not included.",
    );
  });

  it("filters like list and leaves bodies out with bodies none", async () => {
    const data = await exportOf(
      [
        request("a", { url: "https://api.shop.test/v1/a" }),
        response("a"),
        finished("a"),
        request("b", { url: "https://cdn.shop.test/b.png", type: "Image", timestamp: 100.2 }),
        response("b", { mimeType: "image/png" }),
        finished("b", 100.3),
        request("c", { url: "https://api.shop.test/v1/c", method: "POST", timestamp: 100.4 }),
        response("c"),
        finished("c", 100.5),
      ],
      { a: { body: "{}" }, c: { body: "{}" } },
    );
    const urls = (options: Partial<HarBuildOptions>) =>
      buildHar(data, { ...OPTIONS, ...options }).har.log.entries.map((entry) =>
        entry.request.url.split("/").at(-1),
      );

    expect(urls({ urlIncludes: "/v1/" })).toEqual(["a", "c"]);
    expect(urls({ method: "post" })).toEqual(["c"]);
    expect(urls({ resourceType: "other" })).toEqual(["b.png"]);
    expect(urls({ since: 1 })).toEqual(["b.png", "c"]);
    const none = buildHar(data, { ...OPTIONS, bodies: "none" });
    expect(
      none.har.log.entries.map((entry) => [entry.response.content.text, entry._daseo]),
    ).toEqual([
      [undefined, { seq: 1 }],
      [undefined, { seq: 2 }],
      [undefined, { seq: 3 }],
    ]);
    expect(none.har.log.entries[1]?._daseo.bodyUnavailable).toBeUndefined();
  });
});

describe("httpTimings", () => {
  it("uses the whole duration as wait when Chromium sent no timing", async () => {
    const [record] = (await exportOf([request("t"), finished("t", 100.25)])).completed;
    if (!record) throw new Error("no record");

    expect(httpTimings(record)).toEqual({
      timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 250, receive: 0 },
      time: 250,
    });
  });

  it("marks phases a reused connection skipped as -1 and never goes negative", async () => {
    const [record] = (
      await exportOf([
        request("t"),
        response("t", {
          extra: {
            timing: {
              requestTime: 100,
              dnsStart: -1,
              dnsEnd: -1,
              connectStart: -1,
              connectEnd: -1,
              sslStart: -1,
              sslEnd: -1,
              sendStart: 0.5,
              sendEnd: 0.4,
              receiveHeadersEnd: 10,
            },
          },
        }),
        finished("t", 100.012),
      ])
    ).completed;
    if (!record) throw new Error("no record");

    expect(httpTimings(record)).toEqual({
      timings: { blocked: 0.5, dns: -1, connect: -1, ssl: -1, send: 0, wait: 9.6, receive: 2 },
      time: 12.1,
    });
  });
});
