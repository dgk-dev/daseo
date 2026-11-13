import type { BrowserAutomationNetworkCommandArgs } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  matchesNetworkFilter,
  type BodyUnavailableReason,
  type CapturedRequestRecord,
  type NetworkCaptureExport,
  type StreamMessage,
  type WebSocketRecord,
} from "./network-capture.js";

// Daseo delta 99. Builds a HAR 1.2 log from a tab's network capture. Pure: no Electron, no file
// system. The result is not sanitized; network-har-sanitize.ts runs on it before anything leaves
// the function that called this. Field mapping follows Chrome DevTools' HAR log
// (front_end/models/har/Log.ts) and Playwright's harTracer: each redirect hop is its own entry,
// timings count TLS inside connect once, unknown sizes are -1, and a body that is missing or cut
// is marked in `_daseo` instead of being presented as complete.

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarCookie extends HarNameValue {
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  send: number;
  wait: number;
  receive: number;
  ssl: number;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarNameValue[];
  queryString: HarNameValue[];
  postData?: { mimeType: string; text: string };
  headersSize: number;
  bodySize: number;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarNameValue[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
  _error?: string;
  _transferSize?: number;
}

export interface HarWebSocketMessage {
  type: "send" | "receive";
  time: number;
  opcode: number;
  data: string;
  /** Characters of a text frame before it was cut. */
  _totalChars?: number;
  /** A binary frame's length; its data is not kept. */
  _binaryBytes?: number;
}

export interface HarEventSourceMessage {
  time: number;
  eventName: string;
  eventId: string;
  data: string;
  _totalChars?: number;
}

export interface HarDaseoEntry {
  seq?: number;
  bodyTruncated?: { keptBytes: number; totalBytes: number };
  bodyUnavailable?: BodyUnavailableReason;
  requestBodyTruncated?: { keptBytes: number; totalBytes: number };
  requestBodyUnavailable?: boolean;
  framesDropped?: number;
  messagesDropped?: number;
  /** A stream (WebSocket, EventSource) still open at export; its time runs to its last event. */
  open?: boolean;
  blockedReason?: string;
  corsError?: string;
  webSocketError?: string;
}

export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  _resourceType: string;
  _initiator?: { type: string; url?: string };
  _fromCache?: "memory" | "disk";
  _fetchedViaServiceWorker?: boolean;
  _webSocketMessages?: HarWebSocketMessage[];
  _eventSourceMessages?: HarEventSourceMessage[];
  _daseo: HarDaseoEntry;
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
}

export interface HarLog {
  version: "1.2";
  creator: { name: string; version: string };
  browser: { name: string; version: string };
  pages?: HarPage[];
  entries: HarEntry[];
  comment?: string;
  _daseo?: { sanitized: boolean; rules: string };
}

export interface Har {
  log: HarLog;
}

export interface HarBuildOptions {
  creatorVersion: string;
  browserVersion: string;
  /** `api` embeds the bodies the capture kept; `none` embeds none. */
  bodies: "api" | "none";
  urlIncludes?: string;
  method?: string;
  resourceType?: BrowserAutomationNetworkCommandArgs["resourceType"];
  since?: number;
  includeWebSocket: boolean;
}

export type BodyUnavailableCounts = Record<
  "binary" | "evicted" | "budget" | "redirect" | "failed" | "notCaptured",
  number
>;

export interface HarBuildStats {
  entries: number;
  pages: number;
  pendingCount: number;
  droppedCount: number;
  /** Requests for data:, blob:, about:, and other URLs that never touched the network. */
  skippedNonNetwork: number;
  bodies: { embedded: number; truncated: number; unavailable: BodyUnavailableCounts };
  webSockets: { sockets: number; frames: number; framesDropped: number };
  hosts: Array<{ host: string; requests: number }>;
  window?: { firstStartedAt: number; lastStartedAt: number };
}

const MAX_HOSTS = 15;

export function buildHar(
  capture: NetworkCaptureExport,
  options: HarBuildOptions,
): { har: Har; stats: HarBuildStats } {
  const stats: HarBuildStats = {
    entries: 0,
    pages: 0,
    pendingCount: capture.pendingCount,
    droppedCount: capture.droppedCount,
    skippedNonNetwork: 0,
    bodies: {
      embedded: 0,
      truncated: 0,
      unavailable: { binary: 0, evicted: 0, budget: 0, redirect: 0, failed: 0, notCaptured: 0 },
    },
    webSockets: { sockets: 0, frames: 0, framesDropped: 0 },
    hosts: [],
  };
  const items = collectEntries(capture, options, stats);
  const pages = capture.mainFrameId ? buildPages(capture, capture.mainFrameId) : [];
  assignPages(items, pages);
  stats.entries = items.length;
  stats.pages = pages.length;
  summarizeEntries(items, stats);
  const log: HarLog = {
    version: "1.2",
    creator: { name: "Daseo", version: options.creatorVersion },
    browser: { name: "Chromium", version: options.browserVersion },
    ...(pages.length > 0 ? { pages: pages.map((page) => page.page) } : {}),
    entries: items.map((item) => item.entry),
  };
  return { har: { log }, stats };
}

interface OrderedEntry {
  wallSeconds: number;
  order: number;
  entry: HarEntry;
}

function collectEntries(
  capture: NetworkCaptureExport,
  options: HarBuildOptions,
  stats: HarBuildStats,
): OrderedEntry[] {
  const filter = {
    urlIncludes: options.urlIncludes,
    method: options.method,
    resourceType: options.resourceType,
    since: options.since,
  };
  const items: OrderedEntry[] = [];
  for (const record of [...capture.completed, ...capture.open]) {
    if (!matchesNetworkFilter(record, filter)) continue;
    // A data: URL can be megabytes inside request.url and never touched the network; HAR
    // consumers such as har-to-openapi --validate reject the whole file for one such entry.
    if (!isHttpUrl(record.url)) {
      stats.skippedNonNetwork += 1;
      continue;
    }
    items.push({
      wallSeconds: record.wallTime,
      order: items.length,
      entry: httpEntry(record, options, stats),
    });
  }
  // WebSockets are not paged by `since`; they match the other filters as a GET of type other.
  const socketFilter = { ...filter, since: undefined };
  for (const socket of options.includeWebSocket ? capture.webSockets : []) {
    const asRequest = { url: socket.url, method: "GET", resourceType: "other" };
    if (!matchesNetworkFilter(asRequest, socketFilter)) continue;
    items.push({
      wallSeconds: socket.wallTime ?? socket.startedAt / 1000,
      order: items.length,
      entry: webSocketEntry(socket, stats),
    });
  }
  return items.sort(
    (left, right) => left.wallSeconds - right.wallSeconds || left.order - right.order,
  );
}

// Each entry belongs to the latest page that started at or before it.
function assignPages(
  items: OrderedEntry[],
  pages: Array<{ wallSeconds: number; page: HarPage }>,
): void {
  let pageIndex = -1;
  for (const item of items) {
    while ((pages[pageIndex + 1]?.wallSeconds ?? Number.POSITIVE_INFINITY) <= item.wallSeconds) {
      pageIndex += 1;
    }
    const page = pages[pageIndex];
    if (page) item.entry.pageref = page.page.id;
  }
}

function summarizeEntries(items: OrderedEntry[], stats: HarBuildStats): void {
  const hostCounts = new Map<string, number>();
  for (const item of items) {
    const host = hostOf(item.entry.request.url);
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }
  stats.hosts = [...hostCounts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_HOSTS)
    .map(([host, requests]) => ({ host, requests }));
  const starts = items.map((item) => Math.round(item.wallSeconds * 1000));
  if (starts.length > 0) {
    stats.window = { firstStartedAt: Math.min(...starts), lastStartedAt: Math.max(...starts) };
  }
}

/** The `log.comment` an export carries: what is in the file and what is not. */
export function describeHarExport(
  stats: HarBuildStats,
  redactions: Readonly<Record<string, number>>,
  bodies: "api" | "none",
): string {
  const unavailable = Object.entries(stats.bodies.unavailable)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`);
  const replaced = Object.entries(redactions)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return [
    `Sanitized by Daseo: credential headers, cookies, secret parameters and body fields, and JWTs are replaced with <redacted-N> placeholders (${replaced.length > 0 ? replaced.join(", ") : "nothing to replace"}). Personal data in bodies is not removed; keep the file private.`,
    `${stats.entries} entries${stats.pages > 0 ? ` on ${stats.pages} pages` : ""}.`,
    bodies === "none"
      ? "Response bodies were left out (bodies: none)."
      : `${stats.bodies.embedded} response bodies embedded (${stats.bodies.truncated} cut at 2 MiB); not available: ${unavailable.length > 0 ? unavailable.join(", ") : "none"}. Only API-type and textual bodies are kept.`,
    ...(stats.pendingCount > 0
      ? [`${stats.pendingCount} requests still in flight at export are not included.`]
      : []),
    ...(stats.droppedCount > 0
      ? [`${stats.droppedCount} older requests had already been dropped from the tab buffer.`]
      : []),
    ...(stats.skippedNonNetwork > 0
      ? [
          `${stats.skippedNonNetwork} requests for data:, blob:, about:, and other non-network URLs are left out.`,
        ]
      : []),
    ...(stats.webSockets.framesDropped > 0
      ? [`${stats.webSockets.framesDropped} WebSocket frames were not kept (per-socket limit).`]
      : []),
  ].join(" ");
}

function httpEntry(
  record: CapturedRequestRecord,
  options: HarBuildOptions,
  stats: HarBuildStats,
): HarEntry {
  const requestHeaders = headerList(record.wireRequestHeaders);
  const responseHeaders = headerList(record.responseHeaders ?? {});
  const httpVersion = harHttpVersion(record.protocol);
  const { timings, time } = httpTimings(record);
  const daseo = entryMarks(record);
  const fromCache = cacheKind(record);
  const content = harContent(record, responseHeaders, options, stats, daseo);
  const entry: HarEntry = {
    startedDateTime: new Date(record.wallTime * 1000).toISOString(),
    time,
    request: harRequest(record, requestHeaders, httpVersion, daseo),
    response: harResponse(record, responseHeaders, httpVersion, content, fromCache),
    cache: {},
    timings,
    ...connectionFields(record),
    _resourceType: record.cdpType,
    // Copied: the sanitizer edits the HAR in place and must not reach the capture's records.
    ...(record.initiator ? { _initiator: { ...record.initiator } } : {}),
    ...(fromCache ? { _fromCache: fromCache } : {}),
    ...(record.fromServiceWorker ? { _fetchedViaServiceWorker: true } : {}),
    _daseo: daseo,
  };
  const messages = record.eventSourceMessages;
  if (messages) {
    entry._eventSourceMessages = messages.messages.map(eventSourceMessage);
    if (messages.dropped > 0) daseo.messagesDropped = messages.dropped;
  }
  return entry;
}

function entryMarks(record: CapturedRequestRecord): HarDaseoEntry {
  const daseo: HarDaseoEntry = record.seq > 0 ? { seq: record.seq } : { open: true };
  if (record.blockedReason) daseo.blockedReason = record.blockedReason;
  if (record.corsError) daseo.corsError = record.corsError;
  return daseo;
}

function cacheKind(record: CapturedRequestRecord): "memory" | "disk" | undefined {
  if (record.fromMemoryCache) return "memory";
  if (record.fromDiskCache) return "disk";
  return undefined;
}

function connectionFields(
  record: CapturedRequestRecord,
): Pick<HarEntry, "serverIPAddress" | "connection"> {
  return {
    ...(record.remoteIPAddress
      ? { serverIPAddress: record.remoteIPAddress.replace(/^\[(.*)\]$/, "$1") }
      : {}),
    ...(record.connectionId ? { connection: String(record.connectionId) } : {}),
  };
}

function harRequest(
  record: CapturedRequestRecord,
  headers: HarNameValue[],
  httpVersion: string,
  daseo: HarDaseoEntry,
): HarRequest {
  const url = stripFragment(record.url);
  const request: HarRequest = {
    method: record.method,
    url,
    httpVersion,
    cookies: headers
      .filter((header) => header.name.toLowerCase() === "cookie")
      .flatMap((header) => parseCookieHeader(header.value)),
    headers,
    queryString: parseQueryString(url),
    headersSize: -1,
    bodySize: requestBodySize(record),
  };
  if (record.requestBody !== undefined) {
    request.postData = { mimeType: record.requestContentType ?? "", text: record.requestBody };
    if (record.requestBodyTruncated) daseo.requestBodyTruncated = record.requestBodyTruncated;
  } else if (record.hasRequestBody) {
    daseo.requestBodyUnavailable = true;
  }
  return request;
}

function harContent(
  record: CapturedRequestRecord,
  headers: HarNameValue[],
  options: HarBuildOptions,
  stats: HarBuildStats,
  daseo: HarDaseoEntry,
): HarContent {
  const content: HarContent = {
    size: record.responseBody?.totalBytes ?? record.decodedBodyLength ?? -1,
    mimeType: headerValue(headers, "content-type") ?? record.mimeType ?? "x-unknown",
  };
  if (options.bodies === "none") return content;
  const body = record.responseBody;
  if (!body) {
    const reason = record.responseBodyUnavailable ?? "not-captured";
    daseo.bodyUnavailable = reason;
    stats.bodies.unavailable[reason === "not-captured" ? "notCaptured" : reason] += 1;
    return content;
  }
  content.text = body.text;
  stats.bodies.embedded += 1;
  if (body.truncated) {
    stats.bodies.truncated += 1;
    daseo.bodyTruncated = { keptBytes: body.keptBytes, totalBytes: body.totalBytes };
  }
  return content;
}

function harResponse(
  record: CapturedRequestRecord,
  headers: HarNameValue[],
  httpVersion: string,
  content: HarContent,
  fromCache: "memory" | "disk" | undefined,
): HarResponse {
  return {
    status: record.status ?? 0,
    statusText: record.statusText ?? "",
    httpVersion,
    cookies: headers
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => parseSetCookie(header.value)),
    headers,
    content,
    redirectURL: record.redirected ? (headerValue(headers, "location") ?? "") : "",
    headersSize: record.responseHeadersSize ?? -1,
    bodySize: responseBodySize(record, fromCache !== undefined),
    ...(record.failed ? { _error: record.failed } : {}),
    ...(record.encodedDataLength !== undefined ? { _transferSize: record.encodedDataLength } : {}),
  };
}

function webSocketEntry(socket: WebSocketRecord, stats: HarBuildStats): HarEntry {
  const url = stripFragment(socket.url);
  const requestHeaders = headerList(socket.requestHeaders);
  const responseHeaders = headerList(socket.responseHeaders ?? {});
  const wait =
    socket.monotonicResponse !== undefined && socket.monotonicStart !== undefined
      ? round(Math.max(0, (socket.monotonicResponse - socket.monotonicStart) * 1000))
      : 0;
  const messages = socket.frames.messages.map(webSocketMessage);
  stats.webSockets.sockets += 1;
  stats.webSockets.frames += messages.length;
  stats.webSockets.framesDropped += socket.frames.dropped;
  const daseo: HarDaseoEntry = {
    ...(socket.frames.dropped > 0 ? { framesDropped: socket.frames.dropped } : {}),
    ...(socket.monotonicClosed === undefined ? { open: true } : {}),
    ...(socket.error ? { webSocketError: socket.error } : {}),
  };
  return {
    startedDateTime: new Date(socket.startedAt).toISOString(),
    time: wait,
    request: {
      method: "GET",
      url,
      httpVersion: "",
      cookies: requestHeaders
        .filter((header) => header.name.toLowerCase() === "cookie")
        .flatMap((header) => parseCookieHeader(header.value)),
      headers: requestHeaders,
      queryString: parseQueryString(url),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: socket.status ?? 0,
      statusText: socket.statusText ?? "",
      httpVersion: "",
      cookies: responseHeaders
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => parseSetCookie(header.value)),
      headers: responseHeaders,
      content: { size: 0, mimeType: "x-unknown" },
      redirectURL: "",
      headersSize: -1,
      bodySize: socket.status === 101 ? 0 : -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive: 0 },
    _resourceType: "websocket",
    ...(socket.initiator ? { _initiator: { ...socket.initiator } } : {}),
    _webSocketMessages: messages,
    _daseo: daseo,
  };
}

function webSocketMessage(message: StreamMessage): HarWebSocketMessage {
  return {
    type: message.type ?? "receive",
    time: message.time,
    opcode: message.opcode ?? 1,
    data: message.data,
    ...(message.totalChars !== undefined ? { _totalChars: message.totalChars } : {}),
    ...(message.binaryBytes !== undefined ? { _binaryBytes: message.binaryBytes } : {}),
  };
}

function eventSourceMessage(message: StreamMessage): HarEventSourceMessage {
  return {
    time: message.time,
    eventName: message.eventName ?? "",
    eventId: message.eventId ?? "",
    data: message.data,
    ...(message.totalChars !== undefined ? { _totalChars: message.totalChars } : {}),
  };
}

function buildPages(
  capture: NetworkCaptureExport,
  mainFrameId: string,
): Array<{ wallSeconds: number; page: HarPage }> {
  // One page per main-frame navigation: its first hop starts it, its last hop names it.
  const navigations = new Map<string, CapturedRequestRecord[]>();
  for (const record of [...capture.completed, ...capture.open]) {
    if (record.cdpType !== "document" || record.frameId !== mainFrameId) continue;
    if (!isHttpUrl(record.url)) continue;
    const hops = navigations.get(record.requestId) ?? [];
    hops.push(record);
    navigations.set(record.requestId, hops);
  }
  return [...navigations.values()]
    .map((hops) => {
      const firstHop = hops.reduce((left, right) => (right.hop < left.hop ? right : left));
      const lastHop = hops.reduce((left, right) => (right.hop > left.hop ? right : left));
      return { wallSeconds: firstHop.wallTime, url: stripFragment(lastHop.url) };
    })
    .sort((left, right) => left.wallSeconds - right.wallSeconds)
    .map((navigation, index) => ({
      wallSeconds: navigation.wallSeconds,
      page: {
        startedDateTime: new Date(navigation.wallSeconds * 1000).toISOString(),
        id: `page_${index + 1}`,
        title: navigation.url,
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    }));
}

/**
 * HAR timings from CDP's ResourceTiming (offsets in ms from `requestTime`, monotonic seconds).
 * `ssl` is inside `connect` and is not added to `time`; optional phases that did not happen
 * are -1; send, wait, and receive are never negative.
 */
export function httpTimings(record: CapturedRequestRecord): { timings: HarTimings; time: number } {
  const timing = record.timing;
  const requestTime = timing?.requestTime;
  if (!timing || requestTime === undefined) {
    const duration =
      record.monotonicEnd !== undefined && record.monotonicStart > 0
        ? Math.max(0, (record.monotonicEnd - record.monotonicStart) * 1000)
        : 0;
    const timings = {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: round(duration),
      receive: 0,
    };
    return { timings, time: timings.wait };
  }
  const offset = (name: string): number => timing[name] ?? -1;
  const phase = (start: string, end: string): number =>
    offset(start) >= 0 && offset(end) >= 0 ? Math.max(0, offset(end) - offset(start)) : -1;
  const queued =
    record.monotonicStart > 0 && record.monotonicStart < requestTime
      ? (requestTime - record.monotonicStart) * 1000
      : 0;
  const firstPhase = [offset("dnsStart"), offset("connectStart"), offset("sendStart")]
    .filter((value) => value >= 0)
    .reduce((least, value) => Math.min(least, value), Number.POSITIVE_INFINITY);
  const blocked = queued + (Number.isFinite(firstPhase) ? firstPhase : 0);
  const dns = phase("dnsStart", "dnsEnd");
  const connect = phase("connectStart", "connectEnd");
  const ssl = phase("sslStart", "sslEnd");
  const sendEnd = Math.max(offset("sendEnd"), 0);
  const send = Math.max(phase("sendStart", "sendEnd"), 0);
  const headersReceived = headersReceivedOffset(record, offset("receiveHeadersEnd"), sendEnd);
  const wait = Math.max(0, headersReceived - sendEnd);
  const end = record.monotonicEnd ?? record.monotonicResponse;
  const receive =
    end !== undefined ? Math.max(0, (end - requestTime) * 1000 - Math.max(headersReceived, 0)) : 0;
  const timings: HarTimings = {
    blocked: round(blocked),
    dns: round(dns),
    connect: round(connect),
    ssl: round(ssl),
    send: round(send),
    wait: round(wait),
    receive: round(receive),
  };
  const time = [
    timings.blocked,
    timings.dns,
    timings.connect,
    timings.send,
    timings.wait,
    timings.receive,
  ]
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);
  return { timings, time: round(time) };
}

// When the response headers arrived, in ms from requestTime: CDP's own offset, else the
// responseReceived event, else the end of sending.
function headersReceivedOffset(
  record: CapturedRequestRecord,
  receiveHeadersEnd: number,
  sendEnd: number,
): number {
  if (receiveHeadersEnd >= 0) return receiveHeadersEnd;
  const requestTime = record.timing?.requestTime;
  if (record.monotonicResponse !== undefined && requestTime !== undefined) {
    return (record.monotonicResponse - requestTime) * 1000;
  }
  return sendEnd;
}

function requestBodySize(record: CapturedRequestRecord): number {
  if (record.requestBody !== undefined) {
    return record.requestBodyTruncated?.totalBytes ?? Buffer.byteLength(record.requestBody, "utf8");
  }
  return record.hasRequestBody ? -1 : 0;
}

function responseBodySize(record: CapturedRequestRecord, fromCache: boolean): number {
  if (fromCache || record.status === 304) return 0;
  if (record.encodedDataLength !== undefined && record.responseHeadersSize !== undefined) {
    return Math.max(0, record.encodedDataLength - record.responseHeadersSize);
  }
  return -1;
}

/** CDP's protocol name as HAR httpVersion; empty when unknown (never a guessed HTTP/1.1). */
export function harHttpVersion(protocol: string | undefined): string {
  const lower = (protocol ?? "").toLowerCase();
  if (lower === "h2") return "http/2.0";
  if (lower === "h3" || lower.startsWith("h3-") || lower === "quic") return "http/3.0";
  if (lower.startsWith("http/")) return lower;
  return "";
}

/** CDP joins repeated headers with newlines; HAR lists each value (Set-Cookie never merged). */
export function headerList(headers: Record<string, string>): HarNameValue[] {
  return Object.entries(headers).flatMap(([name, value]) =>
    value.split("\n").map((line) => ({ name, value: line })),
  );
}

function headerValue(headers: HarNameValue[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

export function parseCookieHeader(value: string): HarCookie[] {
  return value
    .split(/;\s*/)
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const equals = pair.indexOf("=");
      return equals < 0
        ? { name: "", value: pair }
        : { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1) };
    });
}

export function parseSetCookie(line: string): HarCookie {
  const [pair = "", ...attributes] = line.split(";");
  const equals = pair.indexOf("=");
  const cookie: HarCookie =
    equals < 0
      ? { name: "", value: pair.trim() }
      : { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() };
  for (const attribute of attributes) {
    const [rawName = "", ...rest] = attribute.split("=");
    const name = rawName.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (name === "path") cookie.path = value;
    else if (name === "domain") cookie.domain = value;
    else if (name === "httponly") cookie.httpOnly = true;
    else if (name === "secure") cookie.secure = true;
    else if (name === "expires") {
      const expires = new Date(value);
      if (!Number.isNaN(expires.getTime())) cookie.expires = expires.toISOString();
    }
  }
  return cookie;
}

export function parseQueryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** http(s) requests are entries; WebSockets (ws:, wss:) come from their own records. */
function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url.split(":")[0] || url;
  } catch {
    return "";
  }
}

function round(value: number): number {
  return value < 0 ? -1 : Math.round(value * 1000) / 1000;
}
