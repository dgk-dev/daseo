import { z } from "zod";

export const BrowserAutomationErrorCodeSchema = z.enum([
  "browser_disabled",
  "browser_no_host",
  "browser_tab_not_found",
  "browser_tab_closed",
  "browser_timeout",
  "screenshot_no_frame",
  "browser_denied",
  "browser_unsupported",
  "browser_stale_ref",
  "browser_unknown_error",
]);

const BROWSER_AUTOMATION_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const BROWSER_AUTOMATION_BROWSER_ID_MESSAGE =
  "browserId must be a real id returned by browser_new_tab or browser_list_tabs";
const BROWSER_AUTOMATION_WAIT_CONDITION_MESSAGE =
  "browser_wait requires exactly one of text, url, selector, script, or load";
const BROWSER_AUTOMATION_FIND_QUERY_MESSAGE = "browser_find requires role, name, or both";

export const BROWSER_AUTOMATION_COMMAND_NAMES = [
  "list_tabs",
  "new_tab",
  "snapshot",
  "click",
  "fill",
  "wait",
  "type",
  "keypress",
  "navigate",
  "back",
  "forward",
  "reload",
  "screenshot",
  "upload",
  "select",
  "hover",
  "drag",
  "logs",
  "evaluate",
  "scroll",
  "resize",
  "close_tab",
  "stream_start",
  "stream_stop",
  "stream_input",
  "network",
  "read",
  "find",
] as const;

export const BrowserAutomationCommandNameSchema = z.enum(BROWSER_AUTOMATION_COMMAND_NAMES);

export const BrowserAutomationBrowserIdSchema = z
  .string({ error: () => BROWSER_AUTOMATION_BROWSER_ID_MESSAGE })
  .min(1, BROWSER_AUTOMATION_BROWSER_ID_MESSAGE)
  .regex(BROWSER_AUTOMATION_BROWSER_ID_PATTERN, BROWSER_AUTOMATION_BROWSER_ID_MESSAGE);

const BrowserAutomationTabTargetSchema = z
  .object({
    browserId: BrowserAutomationBrowserIdSchema,
  })
  .strict();

const BrowserAutomationRefSchema = z.string().regex(/^@e\d+$/);
const BrowserAutomationMouseButtonSchema = z.enum(["left", "right", "middle"]);
const BrowserAutomationInputModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
const BrowserAutomationHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "URL must use http or https");

export const BrowserAutomationListTabsCommandSchema = z.object({
  command: z.literal("list_tabs"),
  args: z.object({}).strict().default({}),
});

export const BrowserAutomationNewTabCommandSchema = z.object({
  command: z.literal("new_tab"),
  args: z
    .object({
      url: BrowserAutomationHttpUrlSchema.optional(),
    })
    .strict()
    .default({}),
});

export const BrowserAutomationSnapshotCommandSchema = z.object({
  command: z.literal("snapshot"),
  args: BrowserAutomationTabTargetSchema,
});

export const BrowserAutomationClickCommandSchema = z.object({
  command: z.literal("click"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema,
    button: BrowserAutomationMouseButtonSchema.default("left"),
    doubleClick: z.boolean().default(false),
    modifiers: z.array(BrowserAutomationInputModifierSchema).default([]),
  }),
});

export const BrowserAutomationFillCommandSchema = z.object({
  command: z.literal("fill"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema,
    value: z.string(),
  }),
});

/** `load` waits for the load event; `networkidle` for no requests in flight for 500 ms. */
export const BrowserAutomationWaitLoadStateSchema = z.enum(["load", "networkidle"]);

export const BrowserAutomationWaitCommandSchema = z.object({
  command: z.literal("wait"),
  args: BrowserAutomationTabTargetSchema.extend({
    text: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    /** CSS selector that must match an element (existence only, not visibility). */
    selector: z.string().min(1).optional(),
    /** JavaScript expression (or function) polled until it returns a truthy value. */
    script: z.string().min(1).optional(),
    load: BrowserAutomationWaitLoadStateSchema.optional(),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  }).refine(
    (args) =>
      [args.text, args.url, args.selector, args.script, args.load].filter(Boolean).length === 1,
    { message: BROWSER_AUTOMATION_WAIT_CONDITION_MESSAGE },
  ),
});

export const BrowserAutomationTypeCommandSchema = z.object({
  command: z.literal("type"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema.optional(),
    text: z.string(),
  }),
});

export const BrowserAutomationKeypressCommandSchema = z.object({
  command: z.literal("keypress"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema.optional(),
    key: z.string().min(1),
  }),
});

export const BrowserAutomationNavigateCommandSchema = z.object({
  command: z.literal("navigate"),
  args: BrowserAutomationTabTargetSchema.extend({
    url: BrowserAutomationHttpUrlSchema,
  }),
});

export const BrowserAutomationBackCommandSchema = z.object({
  command: z.literal("back"),
  args: BrowserAutomationTabTargetSchema,
});

export const BrowserAutomationForwardCommandSchema = z.object({
  command: z.literal("forward"),
  args: BrowserAutomationTabTargetSchema,
});

export const BrowserAutomationReloadCommandSchema = z.object({
  command: z.literal("reload"),
  args: BrowserAutomationTabTargetSchema,
});

export const BrowserAutomationScreenshotCommandSchema = z.object({
  command: z.literal("screenshot"),
  args: BrowserAutomationTabTargetSchema.extend({
    fullPage: z.boolean().default(false),
  }),
});

export const BrowserAutomationUploadCommandSchema = z.object({
  command: z.literal("upload"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema,
    filePaths: z.array(z.string().min(1)).min(1),
  }),
});

export const BrowserAutomationSelectCommandSchema = z.object({
  command: z.literal("select"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema,
    value: z.string(),
  }),
});

export const BrowserAutomationHoverCommandSchema = z.object({
  command: z.literal("hover"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema,
  }),
});

export const BrowserAutomationDragCommandSchema = z.object({
  command: z.literal("drag"),
  args: BrowserAutomationTabTargetSchema.extend({
    sourceRef: BrowserAutomationRefSchema,
    targetRef: BrowserAutomationRefSchema,
  }),
});

export const BrowserAutomationLogsCommandSchema = z.object({
  command: z.literal("logs"),
  args: BrowserAutomationTabTargetSchema.extend({
    maxEntries: z.number().int().positive().max(200).default(50),
  }),
});

export const BrowserAutomationEvaluateCommandSchema = z.object({
  command: z.literal("evaluate"),
  args: BrowserAutomationTabTargetSchema.extend({
    function: z.string().min(1),
    ref: BrowserAutomationRefSchema.optional(),
  }),
});

export const BrowserAutomationScrollCommandSchema = z.object({
  command: z.literal("scroll"),
  args: BrowserAutomationTabTargetSchema.extend({
    ref: BrowserAutomationRefSchema.optional(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
});

export const BrowserAutomationResizeCommandSchema = z.object({
  command: z.literal("resize"),
  args: BrowserAutomationTabTargetSchema.extend({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export const BrowserAutomationCloseTabCommandSchema = z.object({
  command: z.literal("close_tab"),
  args: BrowserAutomationTabTargetSchema,
});

export const BrowserAutomationStreamStartCommandSchema = z.object({
  command: z.literal("stream_start"),
  args: BrowserAutomationTabTargetSchema.extend({
    maxWidth: z.number().int().min(120).max(4096).optional(),
    maxHeight: z.number().int().min(120).max(4096).optional(),
    quality: z.number().int().min(10).max(100).optional(),
    minFrameIntervalMs: z.number().int().min(0).max(1_000).optional(),
  }),
});

export const BrowserAutomationStreamStopCommandSchema = z.object({
  command: z.literal("stream_stop"),
  args: BrowserAutomationTabTargetSchema,
});

// Coordinates are CSS pixels in the streamed guest viewport, taken from the
// width/height carried by the latest browser stream frame metadata.
export const BrowserAutomationStreamInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tap"),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    button: BrowserAutomationMouseButtonSchema.optional(),
    doubleTap: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(4096),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.enum([
      "Enter",
      "Backspace",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Delete",
    ]),
  }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("forward") }),
  z.object({ kind: z.literal("reload") }),
  z.object({
    kind: z.literal("navigate"),
    url: BrowserAutomationHttpUrlSchema,
  }),
]);

export const BrowserAutomationStreamInputCommandSchema = z.object({
  command: z.literal("stream_input"),
  args: BrowserAutomationTabTargetSchema.extend({
    input: BrowserAutomationStreamInputSchema,
  }),
});

export const BrowserAutomationNetworkActionSchema = z.enum(["start", "stop", "list"]);
// CDP resource types grouped for agents: xhr and fetch are the site's own API
// calls, document is a page or frame load, other is everything else.
export const BrowserAutomationNetworkResourceTypeSchema = z.enum([
  "xhr",
  "fetch",
  "document",
  "other",
]);

export const BrowserAutomationNetworkCommandSchema = z.object({
  command: z.literal("network"),
  args: BrowserAutomationTabTargetSchema.extend({
    action: BrowserAutomationNetworkActionSchema,
    urlIncludes: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    resourceType: BrowserAutomationNetworkResourceTypeSchema.optional(),
    /** Return only requests completed after this cursor (the `cursor` of an earlier list). */
    since: z.number().int().nonnegative().optional(),
    maxEntries: z.number().int().positive().max(200).default(50),
    includeBodies: z.boolean().default(false),
    includeRequestBodies: z.boolean().default(false),
  }),
});

export const BrowserAutomationReadScopeSchema = z.enum(["main", "page"]);
export const BROWSER_AUTOMATION_READ_DEFAULT_MAX_CHARS = 40_000;
export const BROWSER_AUTOMATION_READ_MAX_CHARS = 120_000;

export const BrowserAutomationReadCommandSchema = z.object({
  command: z.literal("read"),
  args: BrowserAutomationTabTargetSchema.extend({
    /** `main` picks the article with Readability and falls back to `page`; ignored with `ref`. */
    scope: BrowserAutomationReadScopeSchema.default("main"),
    ref: BrowserAutomationRefSchema.optional(),
    links: z.boolean().default(true),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(BROWSER_AUTOMATION_READ_MAX_CHARS)
      .default(BROWSER_AUTOMATION_READ_DEFAULT_MAX_CHARS),
  }),
});

export const BrowserAutomationFindCommandSchema = z.object({
  command: z.literal("find"),
  args: BrowserAutomationTabTargetSchema.extend({
    role: z.string().min(1).optional(),
    /** Accessible name: case-insensitive substring, exact with `exact`, or `/regex/flags`. */
    name: z.string().min(1).optional(),
    exact: z.boolean().default(false),
    limit: z.number().int().positive().max(50).default(10),
  }).refine((args) => Boolean(args.role || args.name), {
    message: BROWSER_AUTOMATION_FIND_QUERY_MESSAGE,
  }),
});

export const BrowserAutomationCommandSchema = z.discriminatedUnion("command", [
  BrowserAutomationListTabsCommandSchema,
  BrowserAutomationNewTabCommandSchema,
  BrowserAutomationSnapshotCommandSchema,
  BrowserAutomationClickCommandSchema,
  BrowserAutomationFillCommandSchema,
  BrowserAutomationWaitCommandSchema,
  BrowserAutomationTypeCommandSchema,
  BrowserAutomationKeypressCommandSchema,
  BrowserAutomationNavigateCommandSchema,
  BrowserAutomationBackCommandSchema,
  BrowserAutomationForwardCommandSchema,
  BrowserAutomationReloadCommandSchema,
  BrowserAutomationScreenshotCommandSchema,
  BrowserAutomationUploadCommandSchema,
  BrowserAutomationSelectCommandSchema,
  BrowserAutomationHoverCommandSchema,
  BrowserAutomationDragCommandSchema,
  BrowserAutomationLogsCommandSchema,
  BrowserAutomationEvaluateCommandSchema,
  BrowserAutomationScrollCommandSchema,
  BrowserAutomationResizeCommandSchema,
  BrowserAutomationCloseTabCommandSchema,
  BrowserAutomationStreamStartCommandSchema,
  BrowserAutomationStreamStopCommandSchema,
  BrowserAutomationStreamInputCommandSchema,
  BrowserAutomationNetworkCommandSchema,
  BrowserAutomationReadCommandSchema,
  BrowserAutomationFindCommandSchema,
]);

export const BrowserAutomationTabInfoSchema = z.object({
  browserId: BrowserAutomationBrowserIdSchema,
  workspaceId: z.string().min(1).optional(),
  kind: z.enum(["tab", "popup"]).optional(),
  rootBrowserId: BrowserAutomationBrowserIdSchema.optional(),
  openerBrowserId: BrowserAutomationBrowserIdSchema.optional(),
  url: z.string(),
  title: z.string(),
  isActive: z.boolean().default(false),
  isLoading: z.boolean().default(false),
  /** How long the tab has been loading, present only while it is. */
  loadingForMs: z.number().int().nonnegative().optional(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
});

export const BrowserAutomationListTabsResultSchema = z.object({
  command: z.literal("list_tabs"),
  tabs: z.array(BrowserAutomationTabInfoSchema),
});

export const BrowserAutomationNewTabResultSchema = z.object({
  command: z.literal("new_tab"),
  browserId: BrowserAutomationBrowserIdSchema,
  workspaceId: z.string().min(1),
  url: z.string().min(1),
});

export const BrowserAutomationSnapshotStatsSchema = z
  .object({
    nodeCount: z.number().int().nonnegative(),
    refCount: z.number().int().nonnegative(),
    textLength: z.number().int().nonnegative(),
    iframeCount: z.number().int().nonnegative().optional(),
    maxDepth: z.number().int().nonnegative().optional(),
  })
  .strict();

export const BrowserAutomationSnapshotResultSchema = z.object({
  command: z.literal("snapshot"),
  browserId: BrowserAutomationBrowserIdSchema,
  workspaceId: z.string().min(1).optional(),
  url: z.string(),
  title: z.string(),
  format: z.literal("aria-yaml"),
  snapshot: z.string(),
  truncated: z.boolean(),
  stats: BrowserAutomationSnapshotStatsSchema,
});

export const BrowserAutomationClickResultSchema = z.object({
  command: z.literal("click"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema,
  x: z.number().optional(),
  y: z.number().optional(),
});

export const BrowserAutomationFillResultSchema = z.object({
  command: z.literal("fill"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema,
});

export const BrowserAutomationWaitResultSchema = z.object({
  command: z.literal("wait"),
  browserId: BrowserAutomationBrowserIdSchema,
  matched: z.enum(["text", "url", "selector", "script", "load", "networkidle"]),
});

export const BrowserAutomationTypeResultSchema = z.object({
  command: z.literal("type"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const BrowserAutomationKeypressResultSchema = z.object({
  command: z.literal("keypress"),
  browserId: BrowserAutomationBrowserIdSchema,
  key: z.string().min(1),
  ref: BrowserAutomationRefSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

// The main-frame response that committed the navigation. Absent when no
// cross-document commit was seen (same-document moves, downloads, old hosts).
const BrowserAutomationNavigationStatusFields = {
  httpStatus: z.number().int().optional(),
  httpStatusText: z.string().optional(),
};

export const BrowserAutomationNavigateResultSchema = z.object({
  command: z.literal("navigate"),
  browserId: BrowserAutomationBrowserIdSchema,
  /** Where the tab committed (after redirects); the requested URL when no commit was seen. */
  url: z.string().min(1),
  ...BrowserAutomationNavigationStatusFields,
});

export const BrowserAutomationBackResultSchema = z.object({
  command: z.literal("back"),
  browserId: BrowserAutomationBrowserIdSchema,
  url: z.string().optional(),
  ...BrowserAutomationNavigationStatusFields,
});

export const BrowserAutomationForwardResultSchema = z.object({
  command: z.literal("forward"),
  browserId: BrowserAutomationBrowserIdSchema,
  url: z.string().optional(),
  ...BrowserAutomationNavigationStatusFields,
});

export const BrowserAutomationReloadResultSchema = z.object({
  command: z.literal("reload"),
  browserId: BrowserAutomationBrowserIdSchema,
  url: z.string().optional(),
  ...BrowserAutomationNavigationStatusFields,
});

export const BrowserAutomationScreenshotResultSchema = z.object({
  command: z.literal("screenshot"),
  browserId: BrowserAutomationBrowserIdSchema,
  mimeType: z.literal("image/png"),
  dataBase64: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

export const BrowserAutomationUploadResultSchema = z.object({
  command: z.literal("upload"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema,
  filePaths: z.array(z.string().min(1)).min(1),
});

export const BrowserAutomationSelectResultSchema = z.object({
  command: z.literal("select"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema,
  value: z.string(),
});

export const BrowserAutomationHoverResultSchema = z.object({
  command: z.literal("hover"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema,
  x: z.number().optional(),
  y: z.number().optional(),
});

export const BrowserAutomationDragResultSchema = z.object({
  command: z.literal("drag"),
  browserId: BrowserAutomationBrowserIdSchema,
  sourceRef: BrowserAutomationRefSchema,
  targetRef: BrowserAutomationRefSchema,
  sourceX: z.number().optional(),
  sourceY: z.number().optional(),
  targetX: z.number().optional(),
  targetY: z.number().optional(),
});

export const BrowserAutomationConsoleLogEntrySchema = z.object({
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
  line: z.number().int().optional(),
  timestamp: z.number(),
});

export const BrowserAutomationNetworkLogEntrySchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  status: z.number().int().optional(),
  type: z.string().optional(),
  startTime: z.number(),
  duration: z.number(),
  transferSize: z.number().optional(),
});

export const BrowserAutomationLogsResultSchema = z.object({
  command: z.literal("logs"),
  browserId: BrowserAutomationBrowserIdSchema,
  console: z.array(BrowserAutomationConsoleLogEntrySchema),
  network: z.array(BrowserAutomationNetworkLogEntrySchema),
});

export const BrowserAutomationEvaluateResultSchema = z.object({
  command: z.literal("evaluate"),
  browserId: BrowserAutomationBrowserIdSchema,
  resultJson: z.string(),
  truncated: z.boolean(),
});

export const BrowserAutomationScrollResultSchema = z.object({
  command: z.literal("scroll"),
  browserId: BrowserAutomationBrowserIdSchema,
  ref: BrowserAutomationRefSchema.optional(),
  deltaX: z.number(),
  deltaY: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const BrowserAutomationResizeResultSchema = z.object({
  command: z.literal("resize"),
  browserId: BrowserAutomationBrowserIdSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const BrowserAutomationCloseTabResultSchema = z.object({
  command: z.literal("close_tab"),
  browserId: BrowserAutomationBrowserIdSchema,
});

export const BrowserAutomationStreamStartResultSchema = z.object({
  command: z.literal("stream_start"),
  browserId: BrowserAutomationBrowserIdSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const BrowserAutomationStreamStopResultSchema = z.object({
  command: z.literal("stream_stop"),
  browserId: BrowserAutomationBrowserIdSchema,
});

export const BrowserAutomationStreamInputResultSchema = z.object({
  command: z.literal("stream_input"),
  browserId: BrowserAutomationBrowserIdSchema,
});

export const BrowserAutomationCapturedRequestSchema = z.object({
  /** Completion order within the tab's capture; `since` pages by it. */
  seq: z.number().int().positive(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  status: z.number().int().optional(),
  mimeType: z.string().optional(),
  /** Chromium's error text when the request failed or was canceled. */
  failed: z.string().optional(),
  /** Epoch milliseconds when the request was sent. */
  startedAt: z.number(),
  durationMs: z.number().nonnegative().optional(),
  /** Page-set request headers; browser-managed ones are left out and credentials read `<redacted>`. */
  requestHeaders: z.record(z.string(), z.string()),
  requestBody: z.string().optional(),
  requestBodyTruncated: z.boolean().optional(),
  responseBody: z.string().optional(),
  responseBodyTruncated: z.boolean().optional(),
  /** Why a requested response body is missing: binary, evicted, redirect, failed, budget. */
  responseBodyUnavailable: z.string().optional(),
});

export const BrowserAutomationNetworkResultSchema = z.object({
  command: z.literal("network"),
  browserId: BrowserAutomationBrowserIdSchema,
  action: BrowserAutomationNetworkActionSchema,
  capturing: z.boolean(),
  entries: z.array(BrowserAutomationCapturedRequestSchema).optional(),
  /** The last returned `seq`, to pass as `since` next time. */
  cursor: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  /** Completed requests dropped because the tab buffer was full. */
  droppedCount: z.number().int().nonnegative().optional(),
});

export const BrowserAutomationReadResultSchema = z.object({
  command: z.literal("read"),
  browserId: BrowserAutomationBrowserIdSchema,
  url: z.string(),
  title: z.string(),
  format: z.literal("markdown"),
  /** What was read: `page` also when `main` found no article. */
  scope: z.enum(["main", "page", "ref"]),
  /** Why a `main` read returned the whole page: a product page, or no article holding the h1. */
  mainFallback: z.enum(["product_page", "no_article"]).optional(),
  /** Structured-data summary (when the page has one) followed by the Markdown body. */
  content: z.string(),
  truncated: z.boolean(),
  stats: z.object({
    /** Length of the full content before `maxChars` cut it. */
    chars: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    structuredDataFound: z.boolean(),
  }),
});

export const BrowserAutomationFindMatchSchema = z.object({
  /** Present for actionable matches; the same ref a snapshot shows for the element. */
  ref: BrowserAutomationRefSchema.optional(),
  role: z.string(),
  name: z.string(),
  /** Snapshot notation: `checked=true`, `disabled=true`, `focused=true`, `level=2`. */
  states: z.array(z.string()),
  /** Nearest landmark or dialog around the element, e.g. `navigation "Main menu"`. */
  landmark: z.string().optional(),
  /** Text of a match without a ref when it adds to the name. */
  text: z.string().optional(),
});

export const BrowserAutomationFindResultSchema = z.object({
  command: z.literal("find"),
  browserId: BrowserAutomationBrowserIdSchema,
  matches: z.array(BrowserAutomationFindMatchSchema),
  /** All matches on the page; `matches` holds at most `limit` of them. */
  total: z.number().int().nonnegative(),
});

export const BrowserAutomationResultSchema = z.discriminatedUnion("command", [
  BrowserAutomationListTabsResultSchema,
  BrowserAutomationNewTabResultSchema,
  BrowserAutomationSnapshotResultSchema,
  BrowserAutomationClickResultSchema,
  BrowserAutomationFillResultSchema,
  BrowserAutomationWaitResultSchema,
  BrowserAutomationTypeResultSchema,
  BrowserAutomationKeypressResultSchema,
  BrowserAutomationNavigateResultSchema,
  BrowserAutomationBackResultSchema,
  BrowserAutomationForwardResultSchema,
  BrowserAutomationReloadResultSchema,
  BrowserAutomationScreenshotResultSchema,
  BrowserAutomationUploadResultSchema,
  BrowserAutomationSelectResultSchema,
  BrowserAutomationHoverResultSchema,
  BrowserAutomationDragResultSchema,
  BrowserAutomationLogsResultSchema,
  BrowserAutomationEvaluateResultSchema,
  BrowserAutomationScrollResultSchema,
  BrowserAutomationResizeResultSchema,
  BrowserAutomationCloseTabResultSchema,
  BrowserAutomationStreamStartResultSchema,
  BrowserAutomationStreamStopResultSchema,
  BrowserAutomationStreamInputResultSchema,
  BrowserAutomationNetworkResultSchema,
  BrowserAutomationReadResultSchema,
  BrowserAutomationFindResultSchema,
]);

export const BrowserAutomationErrorSchema = z.object({
  code: BrowserAutomationErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().default(false),
});

export const BrowserAutomationDialogEventSchema = z.object({
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string(),
  defaultValue: z.string().optional(),
  action: z.enum(["accepted", "dismissed"]),
  promptText: z.string().optional(),
  timestamp: z.number(),
});

export const BrowserAutomationExecuteRequestSchema = z
  .object({
    type: z.literal("browser.automation.execute.request"),
    requestId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    command: BrowserAutomationCommandSchema,
  })
  .strict();

export const BrowserAutomationExecuteResponseSchema = z.object({
  type: z.literal("browser.automation.execute.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(true),
      result: BrowserAutomationResultSchema,
      dialogs: z.array(BrowserAutomationDialogEventSchema).optional(),
    }),
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: BrowserAutomationErrorSchema,
      dialogs: z.array(BrowserAutomationDialogEventSchema).optional(),
    }),
  ]),
});

export type BrowserAutomationErrorCode = z.infer<typeof BrowserAutomationErrorCodeSchema>;
export type BrowserAutomationCommandName = z.infer<typeof BrowserAutomationCommandNameSchema>;
export type BrowserAutomationCommand = z.infer<typeof BrowserAutomationCommandSchema>;
export type BrowserAutomationResult = z.infer<typeof BrowserAutomationResultSchema>;
export type BrowserAutomationConsoleLogEntry = z.infer<
  typeof BrowserAutomationConsoleLogEntrySchema
>;
export type BrowserAutomationNetworkLogEntry = z.infer<
  typeof BrowserAutomationNetworkLogEntrySchema
>;
export type BrowserAutomationDialogEvent = z.infer<typeof BrowserAutomationDialogEventSchema>;
export type BrowserAutomationExecuteRequest = z.infer<typeof BrowserAutomationExecuteRequestSchema>;
export type BrowserAutomationExecuteResponse = z.infer<
  typeof BrowserAutomationExecuteResponseSchema
>;
export type BrowserAutomationStreamInput = z.infer<typeof BrowserAutomationStreamInputSchema>;
export type BrowserAutomationNetworkCommandArgs = z.infer<
  typeof BrowserAutomationNetworkCommandSchema
>["args"];
export type BrowserAutomationCapturedRequest = z.infer<
  typeof BrowserAutomationCapturedRequestSchema
>;
export type BrowserAutomationNetworkResult = z.infer<typeof BrowserAutomationNetworkResultSchema>;
export type BrowserAutomationWaitLoadState = z.infer<typeof BrowserAutomationWaitLoadStateSchema>;
export type BrowserAutomationReadCommandArgs = z.infer<
  typeof BrowserAutomationReadCommandSchema
>["args"];
export type BrowserAutomationReadResult = z.infer<typeof BrowserAutomationReadResultSchema>;
export type BrowserAutomationFindCommandArgs = z.infer<
  typeof BrowserAutomationFindCommandSchema
>["args"];
export type BrowserAutomationFindMatch = z.infer<typeof BrowserAutomationFindMatchSchema>;
export type BrowserAutomationFindResult = z.infer<typeof BrowserAutomationFindResultSchema>;
