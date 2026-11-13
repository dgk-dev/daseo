import type {
  BrowserAutomationCapturedRequest,
  BrowserAutomationNetworkCommandArgs,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

// Opt-in per-tab capture of the page's requests through the CDP Network domain,
// so an agent can learn a site's own API calls and call them directly instead
// of hooking fetch/XMLHttpRequest by hand. Nothing is enabled until a tool call
// starts it, and stop disables the domain again.
//
// Daseo delta 99: while a capture runs, each record also keeps what a HAR export
// needs (wire headers from the ExtraInfo events, response headers, timing, sizes,
// cache and initiator facts), API-type response bodies are copied out of Chromium
// as soon as they finish (a navigation no longer loses them), and WebSocket frames
// and EventSource messages are kept within fixed limits. None of it runs when no
// capture is active.

/** Completed requests kept per tab; the oldest are dropped first. Bodies are bounded separately. */
export const MAX_CAPTURED_REQUESTS = 2_000;
/** Requests still in flight that are tracked; long polls and sockets never finish. */
const MAX_PENDING_REQUESTS = 500;
/** Characters of one request or response body returned to the agent. */
export const MAX_BODY_CHARS = 64 * 1024;
/** Characters of response bodies returned by one list call. */
export const MAX_LIST_BODY_CHARS = 256 * 1024;
/** Decoded bytes of one body kept by the capture; the head is kept and the rest counted. */
export const MAX_SNAPSHOT_BODY_BYTES = 2 * 1024 * 1024;
/** Decoded bytes of kept bodies per tab; the oldest kept bodies go first past it. */
export const MAX_SNAPSHOT_BUDGET_BYTES = 48 * 1024 * 1024;
/** Characters of one WebSocket frame or EventSource message kept. */
export const MAX_STREAM_MESSAGE_CHARS = 16 * 1024;
/** Bytes of WebSocket frames and EventSource messages kept per tab. */
export const MAX_STREAM_BUDGET_BYTES = 4 * 1024 * 1024;
/** WebSocket frames kept per socket: the first and the last this many each. */
export const WEBSOCKET_FRAMES_HEAD = 100;
export const WEBSOCKET_FRAMES_TAIL = 100;
/** EventSource messages kept per stream: the first and the last this many each. */
export const EVENTSOURCE_MESSAGES_HEAD = 250;
export const EVENTSOURCE_MESSAGES_TAIL = 250;
/** WebSockets kept per tab; the oldest closed ones are dropped first. */
export const MAX_WEBSOCKETS = 100;
// Chromium keeps response bodies in these buffers for Network.getResponseBody.
// A body is copied out at loadingFinished, so the 4 MiB per-resource buffer is
// above the 2 MiB kept per body.
const NETWORK_TOTAL_BUFFER_BYTES = 16 * 1024 * 1024;
const NETWORK_RESOURCE_BUFFER_BYTES = 4 * 1024 * 1024;

export const REDACTED = "<redacted>";

// Credentials an agent could not otherwise read: HttpOnly cookies and the
// Authorization header. Values the page's own script can read (URL tokens,
// response bodies) are left as they are in `list`, because browser_evaluate
// reaches them anyway and redacting them would hide the API shape this tool
// exists to show. An export file is sanitized much further (network-har-sanitize.ts).
const CREDENTIAL_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
]);
// Headers the browser sets on every request; they say nothing about the API.
const BROWSER_MANAGED_HEADERS = new Set([
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "dnt",
  "host",
  "origin",
  "pragma",
  "priority",
  "referer",
  "upgrade-insecure-requests",
  "user-agent",
]);

// Form fields that carry a password or one-time code. The credential broker
// fills logins without showing them to the model; a captured login POST must
// not undo that.
const SECRET_FIELD_PATTERN = /(password|passwd|passcode|passphrase|secret)/;
const SECRET_FIELD_NAMES = new Set([
  "pw",
  "pwd",
  "pass",
  "pin",
  "otp",
  "totp",
  "mfacode",
  "otpcode",
  "totpcode",
  "authcode",
  "verificationcode",
  "onetimecode",
]);

export function isSecretFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SECRET_FIELD_PATTERN.test(normalized) ||
    SECRET_FIELD_NAMES.has(normalized) ||
    // login_pw, userPwd, smsOtp
    /(pw|pwd|otp)$/.test(normalized)
  );
}

// Headers whose value is a credential in an export or a listed response header
// (rule S1). WWW-Authenticate is a challenge, not a credential, and is kept.
const EXPORT_CREDENTIAL_HEADERS = new Set([
  ...CREDENTIAL_HEADERS,
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "x-auth-token",
  "x-amz-security-token",
]);
const EXPORT_CREDENTIAL_HEADER_PATTERN = /token|secret|signature|api-key|apikey|session/;

export function isCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "www-authenticate") return false;
  return EXPORT_CREDENTIAL_HEADERS.has(lower) || EXPORT_CREDENTIAL_HEADER_PATTERN.test(lower);
}

/** Which part of a credential header a replaced value came from. */
export type CredentialValueKind = "header" | "cookie";

/**
 * Rule S1: a credential header's value with each secret part passed through `replace`.
 * Authorization keeps its scheme word, Cookie keeps each cookie's name, Set-Cookie keeps the
 * name and attributes. Returns null for a header that is not a credential.
 */
export function redactCredentialHeader(
  name: string,
  value: string,
  replace: (secret: string, kind: CredentialValueKind) => string,
): string | null {
  if (!isCredentialHeaderName(name)) return null;
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization") {
    const scheme = /^(\S+)\s+(\S[\s\S]*)$/.exec(value);
    return scheme ? `${scheme[1]} ${replace(scheme[2] ?? "", "header")}` : replace(value, "header");
  }
  if (lower === "cookie") {
    return value
      .split(/;\s*/)
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const equals = pair.indexOf("=");
        if (equals < 0) return replace(pair, "cookie");
        const cookieValue = pair.slice(equals + 1);
        return `${pair.slice(0, equals)}=${cookieValue ? replace(cookieValue, "cookie") : ""}`;
      })
      .join("; ");
  }
  if (lower === "set-cookie") {
    const semicolon = value.indexOf(";");
    const pair = semicolon < 0 ? value : value.slice(0, semicolon);
    const attributes = semicolon < 0 ? "" : value.slice(semicolon);
    const equals = pair.indexOf("=");
    if (equals < 0) return `${replace(pair, "cookie")}${attributes}`;
    const cookieValue = pair.slice(equals + 1);
    return `${pair.slice(0, equals)}=${cookieValue ? replace(cookieValue, "cookie") : ""}${attributes}`;
  }
  return value ? replace(value, "header") : value;
}

export function pageRequestHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== "object") {
    return result;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(":") || lower.startsWith("sec-") || BROWSER_MANAGED_HEADERS.has(lower)) {
      continue;
    }
    result[name] = CREDENTIAL_HEADERS.has(lower) ? REDACTED : String(value);
  }
  return result;
}

/** Response headers as `list` returns them (L1): credentials redacted by rule S1. */
export function listResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = value
      .split("\n")
      .map((line) => redactCredentialHeader(name, line, () => REDACTED) ?? line)
      .join("\n");
  }
  return result;
}

export function redactRequestBody(body: string, contentType: string | undefined): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("json") || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body)));
    } catch {
      // Not JSON after all; fall through to the form checks.
    }
  }
  if (type.includes("multipart/form-data")) {
    return body.replace(
      /(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g,
      (match, head: string, name: string) =>
        isSecretFieldName(name) ? `${head}${REDACTED}` : match,
    );
  }
  if (type.includes("x-www-form-urlencoded") || (!type && /^[^=&\s]+=[^&\s]*(&|$)/.test(body))) {
    const params = new URLSearchParams(body);
    const secretNames = new Set([...params.keys()].filter(isSecretFieldName));
    if (secretNames.size === 0) {
      return body;
    }
    const redacted = new URLSearchParams();
    for (const [name, value] of params) {
      redacted.append(name, secretNames.has(name) ? REDACTED : value);
    }
    return redacted.toString();
  }
  return body;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        isSecretFieldName(key) && (typeof child === "string" || typeof child === "number")
          ? REDACTED
          : redactJson(child),
      ]),
    );
  }
  return value;
}

export function capBody(
  body: string,
  maxChars = MAX_BODY_CHARS,
): { body: string; truncated: boolean } {
  return body.length <= maxChars
    ? { body, truncated: false }
    : { body: body.slice(0, maxChars), truncated: true };
}

export function groupResourceType(cdpType: string | undefined): string {
  const lower = (cdpType ?? "other").toLowerCase();
  return lower === "xhr" || lower === "fetch" || lower === "document" ? lower : "other";
}

export function isTextMimeType(mimeType: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase();
  return (
    type.startsWith("text/") || /(json|javascript|xml|x-www-form-urlencoded|graphql|csv)/.test(type)
  );
}

/** A text's first `maxBytes` UTF-8 bytes, cut at a character boundary. */
export function utf8Head(
  text: string,
  maxBytes: number,
): { text: string; keptBytes: number; totalBytes: number; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, keptBytes: bytes.length, totalBytes: bytes.length, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    keptBytes: end,
    totalBytes: bytes.length,
    truncated: true,
  };
}

// Resource types whose response body is copied out at loadingFinished; other types only when
// their MIME type is textual, and these never (they stay available to `list` on demand).
const SNAPSHOT_RESOURCE_TYPES = new Set(["xhr", "fetch", "document", "eventsource"]);
const NEVER_SNAPSHOT_RESOURCE_TYPES = new Set(["script", "stylesheet", "image", "font", "media"]);

/** Why a response body is not in the capture. */
export type BodyUnavailableReason =
  | "binary"
  | "evicted"
  | "budget"
  | "redirect"
  | "failed"
  | "not-captured";

/** A body the capture copied out of Chromium. */
export interface KeptBody {
  text: string;
  keptBytes: number;
  totalBytes: number;
  truncated: boolean;
}

/** A WebSocket frame or EventSource message as kept. */
export interface StreamMessage {
  /** Epoch seconds. */
  time: number;
  /** WebSocket: send or receive. */
  type?: "send" | "receive";
  opcode?: number;
  eventName?: string;
  eventId?: string;
  /** Text data, cut at MAX_STREAM_MESSAGE_CHARS; empty for a binary frame. */
  data: string;
  /** Characters of data before the cut. */
  totalChars?: number;
  /** A binary frame: its decoded length. */
  binaryBytes?: number;
  bytes: number;
}

/** First and last messages of one stream within the tab's stream budget. */
export class StreamLog {
  public readonly head: StreamMessage[] = [];
  public readonly tail: StreamMessage[] = [];
  public dropped = 0;

  public constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
    private readonly budget: StreamBudget,
  ) {}

  public get messages(): StreamMessage[] {
    return [...this.head, ...this.tail];
  }

  public get count(): number {
    return this.head.length + this.tail.length;
  }

  public push(message: StreamMessage): void {
    if (!this.budget.take(message.bytes)) {
      this.dropped += 1;
      return;
    }
    if (this.head.length < this.headMax) {
      this.head.push(message);
      return;
    }
    this.tail.push(message);
    while (this.tail.length > this.tailMax) {
      const removed = this.tail.shift();
      if (removed) this.budget.release(removed.bytes);
      this.dropped += 1;
    }
  }

  public release(): void {
    for (const message of [...this.head, ...this.tail]) this.budget.release(message.bytes);
    this.head.length = 0;
    this.tail.length = 0;
  }
}

class StreamBudget {
  private used = 0;
  public constructor(private readonly max: number) {}
  public take(bytes: number): boolean {
    if (this.used + bytes > this.max) return false;
    this.used += bytes;
    return true;
  }
  public release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
  public reset(): void {
    this.used = 0;
  }
}

/** One request hop as the buffer tracks it; `requestId` stays inside the desktop process. */
export interface CapturedRequestRecord {
  /** Completion order; 0 while the request is still in flight. */
  seq: number;
  requestId: string;
  /** Position in the request id's redirect chain, from 0. */
  hop: number;
  method: string;
  url: string;
  /** Grouped type for agents: xhr, fetch, document, other. */
  resourceType: string;
  /** The CDP resource type, lowercase (xhr, fetch, document, script, eventsource, ...). */
  cdpType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: string;
  blockedReason?: string;
  corsError?: string;
  /** Epoch milliseconds when the request was sent. */
  startedAt: number;
  durationMs?: number;
  /** Request headers as `list` shows them: browser-managed left out, credentials redacted. */
  requestHeaders: Record<string, string>;
  /** Request headers as sent (ExtraInfo when it came); for the export, which sanitizes them. */
  wireRequestHeaders: Record<string, string>;
  /** Response headers as received (ExtraInfo when it came, else the response's own). */
  responseHeaders?: Record<string, string>;
  requestContentType?: string;
  requestBody?: string;
  /** The kept request body is the head of a longer one. */
  requestBodyTruncated?: { keptBytes: number; totalBytes: number };
  hasRequestBody: boolean;
  /** A redirect hop: its body belongs to the final response, not this one. */
  redirected: boolean;
  /** Epoch seconds paired with `monotonicStart`, for converting later CDP timestamps. */
  wallTime: number;
  monotonicStart: number;
  monotonicResponse?: number;
  monotonicEnd?: number;
  protocol?: string;
  remoteIPAddress?: string;
  remotePort?: number;
  connectionId?: number;
  /** CDP ResourceTiming of the response. */
  timing?: Record<string, number>;
  /** Byte length of the raw response header block, when Chromium reported it. */
  responseHeadersSize?: number;
  /** Bytes over the wire (loadingFinished.encodedDataLength). */
  encodedDataLength?: number;
  /** Decoded body bytes seen in dataReceived events; undefined when none came. */
  decodedBodyLength?: number;
  fromMemoryCache?: boolean;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  initiator?: { type: string; url?: string };
  frameId?: string;
  responseBody?: KeptBody;
  responseBodyUnavailable?: BodyUnavailableReason;
  eventSourceMessages?: StreamLog;
}

/** One WebSocket from webSocketCreated to webSocketClosed. */
export interface WebSocketRecord {
  requestId: string;
  url: string;
  initiator?: { type: string; url?: string };
  /** Epoch milliseconds of the handshake request (or of creation when it was not seen). */
  startedAt: number;
  wallTime?: number;
  monotonicStart?: number;
  requestHeaders: Record<string, string>;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  monotonicResponse?: number;
  monotonicClosed?: number;
  error?: string;
  frames: StreamLog;
}

/** Network.getResponseBody / getRequestPostData on the tab's queue. */
export interface NetworkBodyFetcher {
  responseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean } | null>;
  requestPostData(requestId: string): Promise<string | null>;
}

export interface NetworkListFilter {
  urlIncludes?: string;
  method?: string;
  resourceType?: BrowserAutomationNetworkCommandArgs["resourceType"];
  since?: number;
  maxEntries: number;
}

export interface NetworkListing {
  entries: CapturedRequestRecord[];
  cursor: number;
  hasMore: boolean;
  pendingCount: number;
  droppedCount: number;
}

/** The capture's records as the HAR export reads them. */
export interface NetworkExportView {
  /** Completed hops, in completion order. */
  completed: CapturedRequestRecord[];
  /** Streams with an answered response that are still open (EventSource). */
  open: CapturedRequestRecord[];
  /** WebSockets whose handshake was answered, open or closed. */
  webSockets: WebSocketRecord[];
  /** Requests still in flight that are not open streams; they are not exported. */
  pendingCount: number;
  droppedCount: number;
  /** A recent pair of CDP monotonic and wall clocks, for open streams' end time. */
  clock: { wall: number; monotonic: number } | null;
}

export function matchesNetworkFilter(
  record: { url: string; method: string; resourceType: string; seq?: number },
  filter: Omit<NetworkListFilter, "maxEntries">,
): boolean {
  const method = filter.method?.toUpperCase();
  return (
    (filter.since === undefined || (record.seq ?? 0) === 0 || (record.seq ?? 0) > filter.since) &&
    (!filter.urlIncludes || record.url.includes(filter.urlIncludes)) &&
    (!method || record.method === method) &&
    (!filter.resourceType || record.resourceType === filter.resourceType)
  );
}

interface ExtraInfoChain {
  hops: CapturedRequestRecord[];
  requests: Record<string, unknown>[];
  responses: Record<string, unknown>[];
}

interface KeptBodyEntry {
  record: CapturedRequestRecord;
  kind: "response" | "request";
  bytes: number;
}

// Entries get their `seq` when they complete, so a cursor never skips a
// request that was still pending when an earlier list returned.
export class NetworkCaptureBuffer {
  private readonly pending = new Map<string, CapturedRequestRecord>();
  private completed: CapturedRequestRecord[] = [];
  private nextSeq = 1;
  private dropped = 0;
  // ExtraInfo events and basic events arrive in either order, one per redirect hop; they are
  // joined by request id and hop index (Playwright's crNetworkManager does the same).
  private readonly chains = new Map<string, ExtraInfoChain>();
  private readonly webSockets = new Map<string, WebSocketRecord>();
  private readonly streamBudget = new StreamBudget(MAX_STREAM_BUDGET_BYTES);
  private keptBodies: KeptBodyEntry[] = [];
  private keptBytes = 0;
  private readonly snapshots = new Set<Promise<void>>();
  // Records dropped from the buffer while a body copy for them was still on its way.
  private readonly released = new WeakSet<CapturedRequestRecord>();
  private generation = 0;
  private clock: { wall: number; monotonic: number } | null = null;

  public constructor(private readonly fetcher?: NetworkBodyFetcher) {}

  private readonly eventHandlers: Readonly<Record<string, EventHandler>> = {
    "Network.requestWillBeSent": (id, params) => this.onRequestWillBeSent(id, params),
    "Network.requestWillBeSentExtraInfo": (id, params) => this.onExtraInfo(id, "requests", params),
    "Network.responseReceivedExtraInfo": (id, params) => this.onExtraInfo(id, "responses", params),
    "Network.responseReceived": (id, params) => this.onResponseReceived(id, params),
    "Network.requestServedFromCache": (id) => {
      const request = this.pending.get(id);
      if (request) request.fromMemoryCache = true;
    },
    "Network.dataReceived": (id, params) => {
      const request = this.pending.get(id);
      const length = readNumber(params.dataLength);
      if (request && length !== null) {
        request.decodedBodyLength = (request.decodedBodyLength ?? 0) + length;
      }
    },
    "Network.loadingFinished": (id, params) => this.onLoadingFinished(id, params),
    "Network.loadingFailed": (id, params) => this.onLoadingFailed(id, params),
    "Network.eventSourceMessageReceived": (id, params) => this.onEventSourceMessage(id, params),
    "Network.webSocketCreated": (id, params) => this.onWebSocketCreated(id, params),
    "Network.webSocketWillSendHandshakeRequest": (id, params) =>
      this.withSocket(id, (socket) => this.onHandshakeRequest(socket, params)),
    "Network.webSocketHandshakeResponseReceived": (id, params) =>
      this.withSocket(id, (socket) => onHandshakeResponse(socket, params)),
    "Network.webSocketFrameSent": (id, params) =>
      this.withSocket(id, (socket) => this.onFrame(socket, "send", params)),
    "Network.webSocketFrameReceived": (id, params) =>
      this.withSocket(id, (socket) => this.onFrame(socket, "receive", params)),
    "Network.webSocketFrameError": (id, params) =>
      this.withSocket(id, (socket) => {
        socket.error = readString(params.errorMessage) ?? "error";
      }),
    "Network.webSocketClosed": (id, params) =>
      this.withSocket(id, (socket) => {
        const timestamp = readNumber(params.timestamp);
        if (timestamp !== null) socket.monotonicClosed = timestamp;
      }),
  };

  public handleEvent(method: string, params: Record<string, unknown>): void {
    const requestId = readString(params.requestId);
    if (requestId) this.eventHandlers[method]?.(requestId, params);
  }

  private onResponseReceived(requestId: string, params: Record<string, unknown>): void {
    const request = this.pending.get(requestId);
    const response = readRecord(params.response);
    if (!request || !response) return;
    applyResponse(request, response);
    request.monotonicResponse = readNumber(params.timestamp) ?? request.monotonicResponse;
    const type = readString(params.type);
    if (type) {
      request.cdpType = type.toLowerCase();
      request.resourceType = groupResourceType(type);
    }
  }

  private onLoadingFinished(requestId: string, params: Record<string, unknown>): void {
    const request = this.pending.get(requestId);
    const encoded = readNumber(params.encodedDataLength);
    if (request && encoded !== null) request.encodedDataLength = encoded;
    const record = this.complete(requestId, readNumber(params.timestamp));
    if (record) this.snapshotResponseBody(record);
  }

  private onLoadingFailed(requestId: string, params: Record<string, unknown>): void {
    const request = this.pending.get(requestId);
    if (request) {
      request.failed =
        params.canceled === true ? "canceled" : (readString(params.errorText) ?? "failed");
      const blocked = readString(params.blockedReason);
      if (blocked) request.blockedReason = blocked;
      const cors = readString(readRecord(params.corsErrorStatus)?.corsError);
      if (cors) request.corsError = cors;
      const type = readString(params.type);
      if (type) request.cdpType = type.toLowerCase();
    }
    this.complete(requestId, readNumber(params.timestamp));
  }

  public list(filter: NetworkListFilter): NetworkListing {
    const since = filter.since ?? 0;
    const matches = this.completed.filter((entry) =>
      matchesNetworkFilter(entry, { ...filter, since }),
    );
    const entries = matches.slice(0, filter.maxEntries);
    return {
      entries,
      cursor: entries.at(-1)?.seq ?? Math.max(since, 0),
      hasMore: matches.length > entries.length,
      pendingCount: this.pending.size,
      droppedCount: this.dropped,
    };
  }

  /** Waits for body copies started so far (each bounded by the tab's CDP queue deadline). */
  public async settled(): Promise<void> {
    while (this.snapshots.size > 0) {
      await Promise.allSettled(this.snapshots);
    }
  }

  public exportView(): NetworkExportView {
    const open = [...this.pending.values()].filter(
      (record) => record.cdpType === "eventsource" && record.status !== undefined,
    );
    const webSockets = [...this.webSockets.values()].filter(
      (socket) => socket.status !== undefined,
    );
    const unansweredSockets = this.webSockets.size - webSockets.length;
    return {
      completed: [...this.completed],
      open,
      webSockets,
      pendingCount: this.pending.size - open.length + unansweredSockets,
      droppedCount: this.dropped,
      clock: this.clock,
    };
  }

  public clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.completed = [];
    this.dropped = 0;
    this.chains.clear();
    this.webSockets.clear();
    this.streamBudget.reset();
    this.keptBodies = [];
    this.keptBytes = 0;
    this.snapshots.clear();
    this.clock = null;
  }

  private onRequestWillBeSent(requestId: string, params: Record<string, unknown>): void {
    const request = readRecord(params.request);
    if (!request) {
      return;
    }
    const monotonic = readNumber(params.timestamp);
    const wallTime = readNumber(params.wallTime);
    if (monotonic !== null && wallTime !== null) this.clock = { wall: wallTime, monotonic };
    // A redirect reuses the request id: the previous hop completes with the
    // redirect response, and the new hop starts.
    const redirectResponse = readRecord(params.redirectResponse);
    const previous = this.pending.get(requestId);
    if (previous && redirectResponse) {
      applyResponse(previous, redirectResponse);
      previous.redirected = true;
      previous.monotonicResponse = monotonic ?? previous.monotonicResponse;
      // A redirect hop gets no loadingFinished; its bytes so far ride on the redirect response.
      const encoded = readNumber(redirectResponse.encodedDataLength);
      if (encoded !== null) previous.encodedDataLength = encoded;
      this.complete(requestId, monotonic);
    }
    const chain = this.chainFor(requestId);
    const record = newRequestRecord(requestId, chain.hops.length, request, params);
    const postData = readString(request.postData);
    if (postData !== null) this.keepRequestBody(record, postData);
    chain.hops.push(record);
    const extraRequest = chain.requests[record.hop];
    if (extraRequest) applyRequestExtraInfo(record, extraRequest);
    const extraResponse = chain.responses[record.hop];
    if (extraResponse) applyResponseExtraInfo(record, extraResponse);
    this.pending.set(requestId, record);
    this.trimPending();
    if (postData === null && request.hasPostData === true) this.snapshotRequestBody(record);
  }

  private trimPending(): void {
    while (this.pending.size > MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.pending.get(oldest);
      this.pending.delete(oldest);
      if (dropped) this.releaseRecord(dropped);
      this.chains.delete(oldest);
    }
  }

  private chainFor(requestId: string): ExtraInfoChain {
    let chain = this.chains.get(requestId);
    if (!chain) {
      chain = { hops: [], requests: [], responses: [] };
      this.chains.set(requestId, chain);
      // ExtraInfo for a request whose basic events never come (a capture started mid-flight)
      // must not grow the map forever.
      const limit = MAX_CAPTURED_REQUESTS + MAX_PENDING_REQUESTS;
      while (this.chains.size > limit) {
        const oldest = this.chains.keys().next().value;
        if (oldest === undefined) break;
        this.chains.delete(oldest);
      }
    }
    return chain;
  }

  private onExtraInfo(
    requestId: string,
    kind: "requests" | "responses",
    params: Record<string, unknown>,
  ): void {
    const socket = this.webSockets.get(requestId);
    if (socket) {
      // The handshake's wire headers (cookies included) come as ExtraInfo too.
      const headers = stringRecord(readRecord(params.headers));
      if (kind === "requests") socket.requestHeaders = headers;
      else socket.responseHeaders = headers;
      return;
    }
    const chain = this.chainFor(requestId);
    chain[kind].push(params);
    const hop = chain.hops[chain[kind].length - 1];
    if (!hop) return;
    if (kind === "requests") applyRequestExtraInfo(hop, params);
    else applyResponseExtraInfo(hop, params);
  }

  private complete(requestId: string, timestamp: number | null): CapturedRequestRecord | null {
    const request = this.pending.get(requestId);
    if (!request) {
      return null;
    }
    this.pending.delete(requestId);
    request.seq = this.nextSeq++;
    if (timestamp !== null) {
      request.monotonicEnd = timestamp;
      if (request.monotonicStart > 0) {
        request.durationMs = Math.max(0, Math.round((timestamp - request.monotonicStart) * 1000));
      }
    }
    if (request.redirected) request.responseBodyUnavailable = "redirect";
    else if (request.failed) request.responseBodyUnavailable = "failed";
    this.completed.push(request);
    if (this.completed.length > MAX_CAPTURED_REQUESTS) {
      const excess = this.completed.length - MAX_CAPTURED_REQUESTS;
      for (const removed of this.completed.splice(0, excess)) this.releaseRecord(removed);
      this.dropped += excess;
    }
    return request;
  }

  private releaseRecord(record: CapturedRequestRecord): void {
    this.released.add(record);
    if (record.responseBody) this.keptBytes -= record.responseBody.keptBytes;
    if (record.requestBody !== undefined) {
      this.keptBytes -= record.requestBodyTruncated?.keptBytes ?? byteLength(record.requestBody);
    }
    record.responseBody = undefined;
    record.requestBody = undefined;
    record.eventSourceMessages?.release();
    const chain = this.chains.get(record.requestId);
    if (chain && chain.hops.at(-1) === record) this.chains.delete(record.requestId);
  }

  private shouldSnapshot(record: CapturedRequestRecord): boolean {
    if (record.redirected || record.failed) return false;
    if (SNAPSHOT_RESOURCE_TYPES.has(record.cdpType)) return true;
    return !NEVER_SNAPSHOT_RESOURCE_TYPES.has(record.cdpType) && isTextMimeType(record.mimeType);
  }

  private track(work: Promise<void>): void {
    this.snapshots.add(work);
    void work.finally(() => this.snapshots.delete(work));
  }

  private snapshotResponseBody(record: CapturedRequestRecord): void {
    if (!this.fetcher || !this.shouldSnapshot(record)) return;
    const fetcher = this.fetcher;
    const generation = this.generation;
    this.track(
      (async () => {
        let result: { body: string; base64Encoded: boolean } | null = null;
        try {
          result = await fetcher.responseBody(record.requestId);
        } catch {
          result = null;
        }
        if (generation !== this.generation || this.released.has(record)) return;
        if (!result) {
          // Chromium evicts bodies when its buffer fills or the page navigates; `list` still
          // tries once more on demand.
          record.responseBodyUnavailable = "evicted";
          return;
        }
        let text = result.body;
        if (result.base64Encoded) {
          const decoded = isTextMimeType(record.mimeType)
            ? decodeUtf8(Buffer.from(result.body, "base64"))
            : null;
          if (decoded === null) {
            record.responseBodyUnavailable = "binary";
            return;
          }
          text = decoded;
        }
        const head = utf8Head(text, MAX_SNAPSHOT_BODY_BYTES);
        record.responseBody = head;
        record.responseBodyUnavailable = undefined;
        this.account(record, "response", head.keptBytes);
      })(),
    );
  }

  private snapshotRequestBody(record: CapturedRequestRecord): void {
    if (!this.fetcher) return;
    const fetcher = this.fetcher;
    const generation = this.generation;
    this.track(
      (async () => {
        let postData: string | null = null;
        try {
          postData = await fetcher.requestPostData(record.requestId);
        } catch {
          postData = null;
        }
        if (generation !== this.generation || this.released.has(record) || postData === null) {
          return;
        }
        this.keepRequestBody(record, postData);
      })(),
    );
  }

  private keepRequestBody(record: CapturedRequestRecord, body: string): void {
    const head = utf8Head(body, MAX_SNAPSHOT_BODY_BYTES);
    record.requestBody = head.text;
    if (head.truncated) {
      record.requestBodyTruncated = { keptBytes: head.keptBytes, totalBytes: head.totalBytes };
    }
    this.account(record, "request", head.keptBytes);
  }

  // The tab's body budget: past it the oldest kept bodies are dropped and marked.
  private account(record: CapturedRequestRecord, kind: "response" | "request", bytes: number) {
    this.keptBodies.push({ record, kind, bytes });
    this.keptBytes += bytes;
    // Entries of records dropped from the buffer are skipped below; prune them now and then so a
    // long capture of small bodies does not keep dropped records alive.
    if (this.keptBodies.length > 2 * (MAX_CAPTURED_REQUESTS + MAX_PENDING_REQUESTS)) {
      this.keptBodies = this.keptBodies.filter((entry) =>
        entry.kind === "response"
          ? entry.record.responseBody?.keptBytes === entry.bytes
          : entry.record.requestBody !== undefined,
      );
    }
    while (this.keptBytes > MAX_SNAPSHOT_BUDGET_BYTES && this.keptBodies.length > 1) {
      const oldest = this.keptBodies.shift();
      if (!oldest) break;
      if (oldest.kind === "response" && oldest.record.responseBody?.keptBytes === oldest.bytes) {
        oldest.record.responseBody = undefined;
        oldest.record.responseBodyUnavailable = "budget";
        this.keptBytes -= oldest.bytes;
      } else if (oldest.kind === "request" && oldest.record.requestBody !== undefined) {
        oldest.record.requestBody = undefined;
        oldest.record.requestBodyTruncated = undefined;
        this.keptBytes -= oldest.bytes;
      }
    }
  }

  private onEventSourceMessage(requestId: string, params: Record<string, unknown>): void {
    const record = this.pending.get(requestId) ?? this.chains.get(requestId)?.hops.at(-1);
    if (!record) return;
    record.eventSourceMessages ??= new StreamLog(
      EVENTSOURCE_MESSAGES_HEAD,
      EVENTSOURCE_MESSAGES_TAIL,
      this.streamBudget,
    );
    const data = readString(params.data) ?? "";
    const kept = data.slice(0, MAX_STREAM_MESSAGE_CHARS);
    record.eventSourceMessages.push({
      time: this.wallSeconds(readNumber(params.timestamp), record.wallTime, record.monotonicStart),
      eventName: readString(params.eventName) ?? "",
      eventId: readString(params.eventId) ?? "",
      data: kept,
      ...(kept.length < data.length ? { totalChars: data.length } : {}),
      bytes: byteLength(kept),
    });
  }

  private withSocket(requestId: string, handle: (socket: WebSocketRecord) => void): void {
    const socket = this.webSockets.get(requestId);
    if (socket) handle(socket);
  }

  private onWebSocketCreated(requestId: string, params: Record<string, unknown>): void {
    const initiator = readInitiator(params.initiator);
    this.webSockets.set(requestId, {
      requestId,
      url: readString(params.url) ?? "",
      ...(initiator ? { initiator } : {}),
      startedAt: Date.now(),
      requestHeaders: {},
      frames: new StreamLog(WEBSOCKET_FRAMES_HEAD, WEBSOCKET_FRAMES_TAIL, this.streamBudget),
    });
    this.trimWebSockets();
  }

  private onHandshakeRequest(socket: WebSocketRecord, params: Record<string, unknown>): void {
    const timestamp = readNumber(params.timestamp);
    const wallTime = readNumber(params.wallTime);
    if (wallTime !== null && timestamp !== null) {
      this.clock = { wall: wallTime, monotonic: timestamp };
      socket.wallTime = wallTime;
      socket.monotonicStart = timestamp;
      socket.startedAt = Math.round(wallTime * 1000);
    }
    // ExtraInfo may have brought the wire headers (cookies included) first.
    if (Object.keys(socket.requestHeaders).length === 0) {
      socket.requestHeaders = stringRecord(readRecord(readRecord(params.request)?.headers ?? null));
    }
  }

  private onFrame(
    socket: WebSocketRecord,
    type: "send" | "receive",
    params: Record<string, unknown>,
  ): void {
    const response = readRecord(params.response);
    const opcode = readNumber(response?.opcode) ?? 1;
    const payload = readString(response?.payloadData) ?? "";
    const time = this.wallSeconds(
      readNumber(params.timestamp),
      socket.wallTime,
      socket.monotonicStart,
    );
    if (opcode !== 1) {
      // Binary and control frames: opcode and length only. CDP sends binary payloads base64.
      socket.frames.push({
        time,
        type,
        opcode,
        data: "",
        binaryBytes: Math.floor((payload.replace(/=+$/, "").length * 3) / 4),
        bytes: 0,
      });
      return;
    }
    const kept = payload.slice(0, MAX_STREAM_MESSAGE_CHARS);
    socket.frames.push({
      time,
      type,
      opcode,
      data: kept,
      ...(kept.length < payload.length ? { totalChars: payload.length } : {}),
      bytes: byteLength(kept),
    });
  }

  private trimWebSockets(): void {
    if (this.webSockets.size <= MAX_WEBSOCKETS) return;
    for (const [id, socket] of this.webSockets) {
      if (this.webSockets.size <= MAX_WEBSOCKETS) break;
      if (socket.monotonicClosed !== undefined || socket.status === undefined) {
        socket.frames.release();
        this.webSockets.delete(id);
      }
    }
  }

  private wallSeconds(
    monotonic: number | null,
    wallTime: number | undefined,
    monotonicStart: number | undefined,
  ): number {
    if (monotonic !== null && wallTime !== undefined && monotonicStart) {
      return wallTime + (monotonic - monotonicStart);
    }
    if (monotonic !== null && this.clock) {
      return this.clock.wall + (monotonic - this.clock.monotonic);
    }
    return Date.now() / 1000;
  }
}

function applyResponse(request: CapturedRequestRecord, response: Record<string, unknown>): void {
  const status = readNumber(response.status);
  const mimeType = readString(response.mimeType);
  if (status !== null) request.status = status;
  if (mimeType) request.mimeType = mimeType;
  const statusText = readString(response.statusText);
  if (statusText !== null) request.statusText = statusText;
  // ExtraInfo headers are the wire headers (Set-Cookie included); keep them when they came first.
  if (!request.responseHeaders) {
    request.responseHeaders = stringRecord(readRecord(response.headers));
  }
  const protocol = readString(response.protocol);
  if (protocol) request.protocol = protocol;
  const ip = readString(response.remoteIPAddress);
  if (ip) request.remoteIPAddress = ip;
  const port = readNumber(response.remotePort);
  if (port !== null) request.remotePort = port;
  const connectionId = readNumber(response.connectionId);
  if (connectionId !== null) request.connectionId = connectionId;
  const timing = readRecord(response.timing);
  if (timing) request.timing = numberRecord(timing);
  if (response.fromDiskCache === true) request.fromDiskCache = true;
  if (response.fromServiceWorker === true) request.fromServiceWorker = true;
  if (response.fromPrefetchCache === true) request.fromPrefetchCache = true;
}

type EventHandler = (requestId: string, params: Record<string, unknown>) => void;

function readInitiator(value: unknown): { type: string; url?: string } | undefined {
  const initiator = readRecord(value);
  if (!initiator) return undefined;
  const url = readString(initiator.url);
  return { type: readString(initiator.type) ?? "other", ...(url ? { url } : {}) };
}

function newRequestRecord(
  requestId: string,
  hop: number,
  request: Record<string, unknown>,
  params: Record<string, unknown>,
): CapturedRequestRecord {
  const headers = stringRecord(readRecord(request.headers));
  const monotonic = readNumber(params.timestamp);
  const wallTime = readNumber(params.wallTime);
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  const cdpType = (readString(params.type) ?? "other").toLowerCase();
  const initiator = readInitiator(params.initiator);
  const frameId = readString(params.frameId);
  return {
    seq: 0,
    requestId,
    hop,
    method: (readString(request.method) ?? "GET").toUpperCase(),
    url: readString(request.url) ?? "",
    resourceType: groupResourceType(cdpType),
    cdpType,
    startedAt: wallTime !== null ? Math.round(wallTime * 1000) : Date.now(),
    wallTime: wallTime ?? Date.now() / 1000,
    monotonicStart: monotonic ?? 0,
    requestHeaders: pageRequestHeaders(headers),
    wireRequestHeaders: headers,
    ...(contentType !== undefined ? { requestContentType: contentType } : {}),
    hasRequestBody: readString(request.postData) !== null || request.hasPostData === true,
    redirected: false,
    ...(initiator ? { initiator } : {}),
    ...(frameId ? { frameId } : {}),
  };
}

function onHandshakeResponse(socket: WebSocketRecord, params: Record<string, unknown>): void {
  const response = readRecord(params.response);
  socket.status = readNumber(response?.status) ?? 0;
  socket.statusText = readString(response?.statusText) ?? "";
  socket.responseHeaders ??= stringRecord(readRecord(response?.headers ?? null));
  const timestamp = readNumber(params.timestamp);
  if (timestamp !== null) socket.monotonicResponse = timestamp;
}

function applyRequestExtraInfo(record: CapturedRequestRecord, info: Record<string, unknown>) {
  const headers = readRecord(info.headers);
  if (headers) record.wireRequestHeaders = stringRecord(headers);
}

function applyResponseExtraInfo(record: CapturedRequestRecord, info: Record<string, unknown>) {
  const headers = readRecord(info.headers);
  if (headers) record.responseHeaders = stringRecord(headers);
  const headersText = readString(info.headersText);
  if (headersText) record.responseHeadersSize = byteLength(headersText);
}

export interface NetworkCaptureDebugger {
  /** Sends a CDP command on the tab's shared debugger session, attaching it if needed. */
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NetworkCaptureListOptions extends NetworkListFilter {
  includeBodies: boolean;
  includeRequestBodies: boolean;
  includeResponseHeaders?: boolean;
}

export interface NetworkCaptureListResult {
  entries: BrowserAutomationCapturedRequest[];
  cursor: number;
  hasMore: boolean;
  pendingCount: number;
  droppedCount: number;
}

/** The capture as the HAR export reads it, once every body copy started has settled. */
export interface NetworkCaptureExport extends NetworkExportView {
  /** The CDP frame id of the tab's main frame, when Chromium reported it. */
  mainFrameId?: string;
}

/** A `browser_wait` load "networkidle" watcher's view of the tab's requests. */
export interface InflightRequestTracker {
  /** Requests sent since tracking began that have not finished or failed. */
  inflight(): number;
  /** The debugger detached while tracking, so the count stopped being observed. */
  lost(): boolean;
  /** Ends tracking; disables the Network domain when nothing else uses it. */
  release(): Promise<void>;
}

/**
 * The per-tab capture. It rides the debugger session the tab already shares
 * with screencast, dialog handling, and trusted input: it never attaches a
 * second client and never detaches, so it cannot interrupt the others.
 *
 * The Network domain also serves `browser_wait` networkidle, which only counts
 * requests in flight and buffers nothing. The domain stays enabled while the
 * capture runs or any idle watcher is waiting.
 */
export class TabNetworkCapture {
  private readonly buffer: NetworkCaptureBuffer;
  private readonly inflightRequestIds = new Set<string>();
  private active = false;
  private domainEnabled = false;
  private idleWatchers = 0;
  private detachGeneration = 0;

  public constructor(private readonly cdp: NetworkCaptureDebugger) {
    this.buffer = new NetworkCaptureBuffer({
      responseBody: async (requestId) => {
        const result = readRecord(
          await this.cdp.sendCommand("Network.getResponseBody", { requestId }),
        );
        const body = readString(result?.body);
        return body === null ? null : { body, base64Encoded: result?.base64Encoded === true };
      },
      requestPostData: async (requestId) =>
        readString(
          readRecord(await this.cdp.sendCommand("Network.getRequestPostData", { requestId }))
            ?.postData,
        ),
    });
  }

  public get capturing(): boolean {
    return this.active;
  }

  /** Feeds every debugger event; ignored unless capture or an idle watcher is running. */
  public handleDebuggerMessage(method: string, params: Record<string, unknown> | undefined): void {
    if (!method.startsWith("Network.")) {
      return;
    }
    if (this.domainEnabled) {
      this.trackInflight(method, params ?? {});
    }
    if (this.active) {
      this.buffer.handleEvent(method, params ?? {});
    }
  }

  /** The debugger went away (DevTools took over, renderer gone): capture has stopped. */
  public handleDebuggerDetached(): void {
    this.active = false;
    this.domainEnabled = false;
    this.inflightRequestIds.clear();
    this.detachGeneration += 1;
  }

  public async start(): Promise<void> {
    this.buffer.clear();
    this.domainEnabled = true;
    await this.cdp.sendCommand("Network.enable", {
      maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
      maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
    });
    this.active = true;
  }

  public async stop(): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    this.buffer.clear();
    if (wasActive) {
      await this.disableDomainWhenUnused();
    }
  }

  /**
   * Counts the tab's requests in flight from now on. Requests sent before the
   * call are not seen, so a caller that needs the whole load also checks that
   * the tab stopped loading.
   */
  public async trackInflightRequests(): Promise<InflightRequestTracker> {
    this.idleWatchers += 1;
    const generation = this.detachGeneration;
    if (!this.domainEnabled) {
      this.inflightRequestIds.clear();
      this.domainEnabled = true;
      try {
        await this.cdp.sendCommand("Network.enable");
      } catch (error) {
        this.idleWatchers -= 1;
        this.domainEnabled = this.active;
        throw error;
      }
    }
    let released = false;
    return {
      inflight: () => this.inflightRequestIds.size,
      lost: () => this.detachGeneration !== generation,
      release: async () => {
        if (released) return;
        released = true;
        this.idleWatchers -= 1;
        await this.disableDomainWhenUnused();
      },
    };
  }

  private async disableDomainWhenUnused(): Promise<void> {
    if (this.active || this.idleWatchers > 0 || !this.domainEnabled) {
      return;
    }
    this.domainEnabled = false;
    this.inflightRequestIds.clear();
    await this.cdp.sendCommand("Network.disable");
  }

  private trackInflight(method: string, params: Record<string, unknown>): void {
    const requestId = readString(params.requestId);
    if (!requestId) {
      return;
    }
    if (method === "Network.requestWillBeSent") {
      // A redirect reuses the request id, so the set keeps counting it once.
      this.inflightRequestIds.add(requestId);
      if (this.inflightRequestIds.size > MAX_PENDING_REQUESTS) {
        const oldest = this.inflightRequestIds.values().next().value;
        if (oldest !== undefined) this.inflightRequestIds.delete(oldest);
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      this.inflightRequestIds.delete(requestId);
    }
  }

  public async list(options: NetworkCaptureListOptions): Promise<NetworkCaptureListResult> {
    await this.buffer.settled();
    const listing = this.buffer.list(options);
    let bodyBudget = MAX_LIST_BODY_CHARS;
    const entries: BrowserAutomationCapturedRequest[] = [];
    for (const record of listing.entries) {
      const entry = publicEntry(record);
      if (options.includeResponseHeaders && record.responseHeaders) {
        entry.responseHeaders = listResponseHeaders(record.responseHeaders);
      }
      if (options.includeRequestBodies && record.hasRequestBody) {
        Object.assign(entry, await this.requestBody(record));
      }
      if (options.includeBodies) {
        const response = await this.responseBody(record, bodyBudget);
        bodyBudget -= response.responseBody?.length ?? 0;
        Object.assign(entry, response);
      }
      entries.push(entry);
    }
    return {
      entries,
      cursor: listing.cursor,
      hasMore: listing.hasMore,
      pendingCount: listing.pendingCount,
      droppedCount: listing.droppedCount,
    };
  }

  /** Everything the capture holds, for the HAR export; body copies started so far finish first. */
  public async exportData(): Promise<NetworkCaptureExport> {
    await this.buffer.settled();
    const view = this.buffer.exportView();
    let mainFrameId: string | undefined;
    try {
      const tree = readRecord(await this.cdp.sendCommand("Page.getFrameTree"));
      mainFrameId = readString(readRecord(readRecord(tree?.frameTree)?.frame)?.id) ?? undefined;
    } catch {
      // Without the main frame's id the export has no pages, which HAR allows.
    }
    return { ...view, ...(mainFrameId ? { mainFrameId } : {}) };
  }

  private async requestBody(
    record: CapturedRequestRecord,
  ): Promise<Pick<BrowserAutomationCapturedRequest, "requestBody" | "requestBodyTruncated">> {
    let body = record.requestBody;
    if (body === undefined) {
      // Chromium leaves large or multi-part bodies out of the event.
      try {
        const result = readRecord(
          await this.cdp.sendCommand("Network.getRequestPostData", {
            requestId: record.requestId,
          }),
        );
        body = readString(result?.postData) ?? undefined;
      } catch {
        return {};
      }
    }
    if (body === undefined) {
      return {};
    }
    const capped = capBody(redactRequestBody(body, record.requestContentType));
    return {
      requestBody: capped.body,
      ...(capped.truncated || record.requestBodyTruncated ? { requestBodyTruncated: true } : {}),
    };
  }

  private async responseBody(
    record: CapturedRequestRecord,
    budget: number,
  ): Promise<
    Pick<
      BrowserAutomationCapturedRequest,
      "responseBody" | "responseBodyTruncated" | "responseBodyUnavailable"
    >
  > {
    if (record.failed) return { responseBodyUnavailable: "failed" };
    if (record.redirected) return { responseBodyUnavailable: "redirect" };
    if (budget <= 0) return { responseBodyUnavailable: "budget" };
    // A body copied at loadingFinished survives the page navigating away.
    if (record.responseBody) {
      const capped = capBody(record.responseBody.text, Math.min(MAX_BODY_CHARS, budget));
      return {
        responseBody: capped.body,
        ...(capped.truncated || record.responseBody.truncated
          ? { responseBodyTruncated: true }
          : {}),
      };
    }
    if (record.responseBodyUnavailable === "binary") return { responseBodyUnavailable: "binary" };
    let result: Record<string, unknown> | null;
    try {
      result = readRecord(
        await this.cdp.sendCommand("Network.getResponseBody", { requestId: record.requestId }),
      );
    } catch {
      // Chromium evicts bodies when its buffer fills or the page navigates.
      return { responseBodyUnavailable: "evicted" };
    }
    const raw = readString(result?.body);
    if (raw === null) {
      return { responseBodyUnavailable: "evicted" };
    }
    let text = raw;
    if (result?.base64Encoded === true) {
      if (!isTextMimeType(record.mimeType)) {
        return { responseBodyUnavailable: "binary" };
      }
      text = Buffer.from(raw, "base64").toString("utf8");
    }
    const capped = capBody(text, Math.min(MAX_BODY_CHARS, budget));
    return {
      responseBody: capped.body,
      ...(capped.truncated ? { responseBodyTruncated: true } : {}),
    };
  }
}

/** What the automation service needs from a tab's capture. */
export type NetworkCaptureControl = Pick<
  TabNetworkCapture,
  "capturing" | "start" | "stop" | "list" | "exportData" | "trackInflightRequests"
>;

function publicEntry(record: CapturedRequestRecord): BrowserAutomationCapturedRequest {
  return {
    seq: record.seq,
    method: record.method,
    url: record.url,
    resourceType: record.resourceType,
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    ...(record.failed ? { failed: record.failed } : {}),
    startedAt: record.startedAt,
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    requestHeaders: record.requestHeaders,
  };
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function stringRecord(value: Record<string, unknown> | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) return result;
  for (const [name, child] of Object.entries(value)) {
    if (child !== undefined && child !== null) result[name] = String(child);
  }
  return result;
}

function numberRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, child] of Object.entries(value)) {
    if (typeof child === "number" && Number.isFinite(child)) result[name] = child;
  }
  return result;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
