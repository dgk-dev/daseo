import type {
  BrowserAutomationCapturedRequest,
  BrowserAutomationNetworkCommandArgs,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

// Opt-in per-tab capture of the page's requests through the CDP Network domain,
// so an agent can learn a site's own API calls and call them directly instead
// of hooking fetch/XMLHttpRequest by hand. Nothing is enabled until a tool call
// starts it, and stop disables the domain again.

/** Completed requests kept per tab; the oldest are dropped first. */
export const MAX_CAPTURED_REQUESTS = 500;
/** Requests still in flight that are tracked; long polls and sockets never finish. */
const MAX_PENDING_REQUESTS = 500;
/** Characters of one request or response body returned to the agent. */
export const MAX_BODY_CHARS = 64 * 1024;
/** Characters of response bodies returned by one list call. */
export const MAX_LIST_BODY_CHARS = 256 * 1024;
// Chromium keeps response bodies in these buffers for Network.getResponseBody.
const NETWORK_TOTAL_BUFFER_BYTES = 16 * 1024 * 1024;
const NETWORK_RESOURCE_BUFFER_BYTES = 4 * 1024 * 1024;

export const REDACTED = "<redacted>";

// Credentials an agent could not otherwise read: HttpOnly cookies and the
// Authorization header. Values the page's own script can read (URL tokens,
// response bodies) are left as they are, because browser_evaluate reaches them
// anyway and redacting them would hide the API shape this tool exists to show.
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

/** One request as the buffer tracks it; `requestId` stays inside the desktop process. */
export interface CapturedRequestRecord {
  seq: number;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  startedAt: number;
  durationMs?: number;
  requestHeaders: Record<string, string>;
  requestContentType?: string;
  requestBody?: string;
  hasRequestBody: boolean;
  /** A redirect hop: its body belongs to the final response, not this one. */
  redirected: boolean;
}

interface PendingRequest extends Omit<CapturedRequestRecord, "seq"> {
  sentAtMonotonic: number;
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

// Entries get their `seq` when they complete, so a cursor never skips a
// request that was still pending when an earlier list returned.
export class NetworkCaptureBuffer {
  private readonly pending = new Map<string, PendingRequest>();
  private completed: CapturedRequestRecord[] = [];
  private nextSeq = 1;
  private dropped = 0;

  public handleEvent(method: string, params: Record<string, unknown>): void {
    const requestId = readString(params.requestId);
    if (!requestId) {
      return;
    }
    if (method === "Network.requestWillBeSent") {
      this.onRequestWillBeSent(requestId, params);
    } else if (method === "Network.responseReceived") {
      const request = this.pending.get(requestId);
      const response = readRecord(params.response);
      if (request && response) {
        applyResponse(request, response);
      }
    } else if (method === "Network.loadingFinished") {
      this.complete(requestId, readNumber(params.timestamp));
    } else if (method === "Network.loadingFailed") {
      const request = this.pending.get(requestId);
      if (request) {
        request.failed =
          params.canceled === true ? "canceled" : (readString(params.errorText) ?? "failed");
      }
      this.complete(requestId, readNumber(params.timestamp));
    }
  }

  public list(filter: NetworkListFilter): NetworkListing {
    const since = filter.since ?? 0;
    const method = filter.method?.toUpperCase();
    const matches = this.completed.filter(
      (entry) =>
        entry.seq > since &&
        (!filter.urlIncludes || entry.url.includes(filter.urlIncludes)) &&
        (!method || entry.method === method) &&
        (!filter.resourceType || entry.resourceType === filter.resourceType),
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

  public clear(): void {
    this.pending.clear();
    this.completed = [];
    this.dropped = 0;
  }

  private onRequestWillBeSent(requestId: string, params: Record<string, unknown>): void {
    const request = readRecord(params.request);
    if (!request) {
      return;
    }
    // A redirect reuses the request id: the previous hop completes with the
    // redirect response, and the new hop starts.
    const redirectResponse = readRecord(params.redirectResponse);
    const previous = this.pending.get(requestId);
    if (previous && redirectResponse) {
      applyResponse(previous, redirectResponse);
      previous.redirected = true;
      this.complete(requestId, readNumber(params.timestamp));
    }
    const headers = readRecord(request.headers) ?? {};
    const postData = readString(request.postData);
    const contentTypeHeader = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const wallTime = readNumber(params.wallTime);
    this.pending.set(requestId, {
      requestId,
      method: (readString(request.method) ?? "GET").toUpperCase(),
      url: readString(request.url) ?? "",
      resourceType: groupResourceType(readString(params.type) ?? undefined),
      startedAt: wallTime !== null ? Math.round(wallTime * 1000) : Date.now(),
      sentAtMonotonic: readNumber(params.timestamp) ?? 0,
      requestHeaders: pageRequestHeaders(headers),
      ...(typeof contentTypeHeader === "string" ? { requestContentType: contentTypeHeader } : {}),
      ...(postData !== null ? { requestBody: postData } : {}),
      hasRequestBody: postData !== null || request.hasPostData === true,
      redirected: false,
    });
    while (this.pending.size > MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  private complete(requestId: string, timestamp: number | null): void {
    const request = this.pending.get(requestId);
    if (!request) {
      return;
    }
    this.pending.delete(requestId);
    const { sentAtMonotonic, ...record } = request;
    this.completed.push({
      ...record,
      seq: this.nextSeq++,
      ...(timestamp !== null && sentAtMonotonic > 0
        ? { durationMs: Math.max(0, Math.round((timestamp - sentAtMonotonic) * 1000)) }
        : {}),
    });
    if (this.completed.length > MAX_CAPTURED_REQUESTS) {
      const excess = this.completed.length - MAX_CAPTURED_REQUESTS;
      this.completed.splice(0, excess);
      this.dropped += excess;
    }
  }
}

function applyResponse(request: PendingRequest, response: Record<string, unknown>): void {
  const status = readNumber(response.status);
  const mimeType = readString(response.mimeType);
  if (status !== null) request.status = status;
  if (mimeType) request.mimeType = mimeType;
}

export interface NetworkCaptureDebugger {
  /** Sends a CDP command on the tab's shared debugger session, attaching it if needed. */
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NetworkCaptureListOptions extends NetworkListFilter {
  includeBodies: boolean;
  includeRequestBodies: boolean;
}

export interface NetworkCaptureListResult {
  entries: BrowserAutomationCapturedRequest[];
  cursor: number;
  hasMore: boolean;
  pendingCount: number;
  droppedCount: number;
}

/**
 * The per-tab capture. It rides the debugger session the tab already shares
 * with screencast, dialog handling, and trusted input: it never attaches a
 * second client and never detaches, so it cannot interrupt the others.
 */
export class TabNetworkCapture {
  private readonly buffer = new NetworkCaptureBuffer();
  private active = false;

  public constructor(private readonly cdp: NetworkCaptureDebugger) {}

  public get capturing(): boolean {
    return this.active;
  }

  /** Feeds every debugger event; ignored unless capture is running. */
  public handleDebuggerMessage(method: string, params: Record<string, unknown> | undefined): void {
    if (this.active && method.startsWith("Network.")) {
      this.buffer.handleEvent(method, params ?? {});
    }
  }

  /** The debugger went away (DevTools took over, renderer gone): capture has stopped. */
  public handleDebuggerDetached(): void {
    this.active = false;
  }

  public async start(): Promise<void> {
    this.buffer.clear();
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
      await this.cdp.sendCommand("Network.disable");
    }
  }

  public async list(options: NetworkCaptureListOptions): Promise<NetworkCaptureListResult> {
    const listing = this.buffer.list(options);
    let bodyBudget = MAX_LIST_BODY_CHARS;
    const entries: BrowserAutomationCapturedRequest[] = [];
    for (const record of listing.entries) {
      const entry = publicEntry(record);
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
      ...(capped.truncated ? { requestBodyTruncated: true } : {}),
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
  "capturing" | "start" | "stop" | "list"
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

function isTextMimeType(mimeType: string | undefined): boolean {
  const type = (mimeType ?? "").toLowerCase();
  return (
    type.startsWith("text/") || /(json|javascript|xml|x-www-form-urlencoded|graphql|csv)/.test(type)
  );
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
