import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import { registerBrowserTools, type RegisterBrowserToolsOptions } from "./tools.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const POPUP_BROWSER_ID = "22222222-2222-4222-8222-222222222222";
const BROWSER_ID_MESSAGE =
  "browserId must be a real id returned by browser_new_tab or browser_list_tabs";
const WAIT_CONDITION_MESSAGE =
  "browser_wait requires one condition (text, url, selector, script, or load), or timeoutMs alone to pause";
const HTTP_URL_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";

interface RegisteredTool {
  config: PaseoToolConfig;
  handler: (args: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

class FakeBrowserBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];

  public constructor(private response: BrowserToolsResponsePayload = listTabsPayload()) {}

  public setResponse(response: BrowserToolsResponsePayload): void {
    this.response = response;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    return this.response;
  }
}

class BrowserToolHarness {
  public readonly broker = new FakeBrowserBroker();
  private readonly tools = new Map<string, RegisteredTool>();

  public constructor(
    private readonly callerAgent: ReturnType<RegisterBrowserToolsOptions["resolveCallerAgent"]> = {
      id: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
    },
    private readonly callerAgentId: string | null = "agent-1",
  ) {
    registerBrowserTools({
      registerTool: (name, config, handler) => {
        this.tools.set(name, { config, handler });
      },
      broker: this.broker as Pick<BrowserToolsBroker, "execute">,
      ...(this.callerAgentId ? { callerAgentId: this.callerAgentId } : {}),
      resolveCallerAgent: () => this.callerAgent,
    });
  }

  public validate(name: string, input: unknown) {
    return schemaFor(this.get(name).config.inputSchema).safeParse(input);
  }

  public async execute(name: string, input: unknown): Promise<PaseoToolResult> {
    const parsed = schemaFor(this.get(name).config.inputSchema).parse(input);
    return this.get(name).handler(parsed, {});
  }

  public toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  private get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not registered: ${name}`);
    }
    return tool;
  }
}

function schemaFor(inputSchema: PaseoToolConfig["inputSchema"]): z.ZodType {
  if (!inputSchema) {
    return z.object({}).passthrough();
  }
  if (typeof (inputSchema as { safeParse?: unknown }).safeParse === "function") {
    return inputSchema as z.ZodType;
  }
  return z.object(inputSchema as z.ZodRawShape).passthrough();
}

function listTabsPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-list-tabs",
    ok: true,
    result: {
      command: "list_tabs",
      tabs: [
        {
          browserId: BROWSER_ID,
          url: "https://example.com",
          title: "Example",
          isActive: true,
          isLoading: false,
        },
      ],
    },
  };
}

function newTabPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-new-tab",
    ok: true,
    result: {
      command: "new_tab",
      browserId: BROWSER_ID,
      workspaceId: "wks_workspace_a",
      url: "https://example.com",
    },
  };
}

function snapshotPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-snapshot",
    ok: true,
    result: {
      command: "snapshot",
      browserId: BROWSER_ID,
      workspaceId: "wks_workspace_a",
      url: "https://example.com",
      title: "Example",
      format: "aria-yaml",
      snapshot: '- document "Example"\n  - button "Save" [ref=@e1]',
      truncated: false,
      stats: { nodeCount: 2, refCount: 1, textLength: 50 },
    },
  };
}

function screenshotPayload(): Extract<BrowserToolsResponsePayload, { ok: true }> {
  return {
    requestId: "req-screenshot",
    ok: true,
    result: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      width: 800,
      height: 600,
    },
  };
}

const routedToolCases = [
  {
    name: "click",
    toolName: "browser_click",
    input: { browserId: BROWSER_ID, ref: "@e2" },
    command: {
      command: "click",
      args: {
        browserId: BROWSER_ID,
        ref: "@e2",
        button: "left",
        doubleClick: false,
        modifiers: [],
      },
    },
    payload: {
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e2" },
    },
    content: [{ type: "text", text: "Clicked browser element @e2." }],
  },
  {
    name: "click options",
    toolName: "browser_click",
    input: {
      browserId: BROWSER_ID,
      ref: "@e2",
      button: "right",
      doubleClick: true,
      modifiers: ["Control", "Shift"],
    },
    command: {
      command: "click",
      args: {
        browserId: BROWSER_ID,
        ref: "@e2",
        button: "right",
        doubleClick: true,
        modifiers: ["Control", "Shift"],
      },
    },
    payload: {
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e2" },
    },
    content: [{ type: "text", text: "Clicked browser element @e2." }],
  },
  {
    name: "fill",
    toolName: "browser_fill",
    input: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" },
    command: { command: "fill", args: { browserId: BROWSER_ID, ref: "@e1", value: "Ada" } },
    payload: {
      requestId: "req-fill",
      ok: true,
      result: { command: "fill", browserId: BROWSER_ID, ref: "@e1" },
    },
    content: [{ type: "text", text: "Filled browser element @e1." }],
  },
  {
    name: "type",
    toolName: "browser_type",
    input: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" },
    command: { command: "type", args: { browserId: BROWSER_ID, ref: "@e1", text: "Ada" } },
    payload: {
      requestId: "req-type",
      ok: true,
      result: { command: "type", browserId: BROWSER_ID, ref: "@e1" },
    },
    content: [{ type: "text", text: "Typed into browser element @e1." }],
  },
  {
    name: "keypress",
    toolName: "browser_keypress",
    input: { browserId: BROWSER_ID, key: "Enter" },
    command: { command: "keypress", args: { browserId: BROWSER_ID, key: "Enter" } },
    payload: {
      requestId: "req-keypress",
      ok: true,
      result: { command: "keypress", browserId: BROWSER_ID, key: "Enter" },
    },
    content: [{ type: "text", text: "Pressed Enter in the browser." }],
  },
  {
    name: "back",
    toolName: "browser_back",
    input: { browserId: BROWSER_ID },
    command: { command: "back", args: { browserId: BROWSER_ID } },
    payload: {
      requestId: "req-back",
      ok: true,
      result: { command: "back", browserId: BROWSER_ID },
    },
    content: [{ type: "text", text: "Browser back complete." }],
  },
  {
    name: "screenshot",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID },
    command: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: false } },
    payload: screenshotPayload(),
    content: [
      { type: "text", text: "Captured browser screenshot (800x600)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    structuredResult: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      width: 800,
      height: 600,
    },
  },
  {
    name: "logs",
    toolName: "browser_logs",
    input: { browserId: BROWSER_ID },
    command: { command: "logs", args: { browserId: BROWSER_ID, maxEntries: 50 } },
    payload: {
      requestId: "req-logs",
      ok: true,
      result: {
        command: "logs",
        browserId: BROWSER_ID,
        console: [{ level: "info", message: "ready", timestamp: 10 }],
        network: [
          {
            url: "https://example.com/app.js",
            type: "script",
            startTime: 1,
            duration: 2,
          },
        ],
      },
    },
    content: [{ type: "text", text: "Read 1 console log and 1 network entry." }],
  },
  {
    name: "full page screenshot",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID, fullPage: true },
    command: { command: "screenshot", args: { browserId: BROWSER_ID, fullPage: true } },
    payload: {
      requestId: "req-full-page",
      ok: true,
      result: {
        command: "screenshot",
        browserId: BROWSER_ID,
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        width: 390,
        height: 1200,
      },
    },
    content: [
      { type: "text", text: "Captured browser screenshot (390x1200)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    structuredResult: {
      command: "screenshot",
      browserId: BROWSER_ID,
      mimeType: "image/png",
      width: 390,
      height: 1200,
    },
  },
  {
    name: "upload",
    toolName: "browser_upload",
    input: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    command: {
      command: "upload",
      args: { browserId: BROWSER_ID, ref: "@e1", filePaths: ["/tmp/file.txt"] },
    },
    payload: {
      requestId: "req-upload",
      ok: true,
      result: {
        command: "upload",
        browserId: BROWSER_ID,
        ref: "@e1",
        filePaths: ["/tmp/file.txt"],
      },
    },
    content: [{ type: "text", text: "Uploaded 1 file to browser element @e1." }],
  },
  {
    name: "select",
    toolName: "browser_select",
    input: { browserId: BROWSER_ID, ref: "@e3", value: "us" },
    command: { command: "select", args: { browserId: BROWSER_ID, ref: "@e3", value: "us" } },
    payload: {
      requestId: "req-select",
      ok: true,
      result: { command: "select", browserId: BROWSER_ID, ref: "@e3", value: "us" },
    },
    content: [{ type: "text", text: "Selected us in browser element @e3." }],
  },
  {
    name: "hover",
    toolName: "browser_hover",
    input: { browserId: BROWSER_ID, ref: "@e4" },
    command: { command: "hover", args: { browserId: BROWSER_ID, ref: "@e4" } },
    payload: {
      requestId: "req-hover",
      ok: true,
      result: { command: "hover", browserId: BROWSER_ID, ref: "@e4" },
    },
    content: [{ type: "text", text: "Hovered browser element @e4." }],
  },
  {
    name: "drag",
    toolName: "browser_drag",
    input: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    command: {
      command: "drag",
      args: { browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
    payload: {
      requestId: "req-drag",
      ok: true,
      result: { command: "drag", browserId: BROWSER_ID, sourceRef: "@e4", targetRef: "@e5" },
    },
    content: [{ type: "text", text: "Dragged browser element @e4 to @e5." }],
  },
  {
    name: "evaluate",
    toolName: "browser_evaluate",
    input: { browserId: BROWSER_ID, function: "(element) => element.textContent", ref: "@e1" },
    command: {
      command: "evaluate",
      args: { browserId: BROWSER_ID, function: "(element) => element.textContent", ref: "@e1" },
    },
    payload: {
      requestId: "req-evaluate",
      ok: true,
      result: {
        command: "evaluate",
        browserId: BROWSER_ID,
        resultJson: '"Save"',
        truncated: false,
      },
    },
    content: [{ type: "text", text: 'Browser evaluate returned:\n"Save"' }],
  },
  {
    name: "scroll",
    toolName: "browser_scroll",
    input: { browserId: BROWSER_ID, ref: "@e1", deltaX: 0, deltaY: 400 },
    command: {
      command: "scroll",
      args: { browserId: BROWSER_ID, ref: "@e1", deltaX: 0, deltaY: 400 },
    },
    payload: {
      requestId: "req-scroll",
      ok: true,
      result: {
        command: "scroll",
        browserId: BROWSER_ID,
        ref: "@e1",
        deltaX: 0,
        deltaY: 400,
      },
    },
    content: [{ type: "text", text: "Scrolled browser element @e1 by 0, 400." }],
  },
  {
    name: "resize",
    toolName: "browser_resize",
    input: { browserId: BROWSER_ID, width: 1024, height: 768 },
    command: {
      command: "resize",
      args: { browserId: BROWSER_ID, width: 1024, height: 768 },
    },
    payload: {
      requestId: "req-resize",
      ok: true,
      result: {
        command: "resize",
        browserId: BROWSER_ID,
        width: 1024,
        height: 768,
      },
    },
    content: [{ type: "text", text: "Resized browser viewport to 1024x768." }],
  },
  {
    name: "close_tab",
    toolName: "browser_close_tab",
    input: { browserId: BROWSER_ID },
    command: {
      command: "close_tab",
      args: { browserId: BROWSER_ID },
    },
    payload: {
      requestId: "req-close-tab",
      ok: true,
      result: {
        command: "close_tab",
        browserId: BROWSER_ID,
      },
    },
    content: [{ type: "text", text: `Closed browser tab ${BROWSER_ID}.` }],
  },
  {
    name: "network start",
    toolName: "browser_network",
    input: { browserId: BROWSER_ID, action: "start" },
    command: {
      command: "network",
      args: {
        browserId: BROWSER_ID,
        action: "start",
        maxEntries: 50,
        includeBodies: false,
        includeRequestBodies: false,
      },
    },
    payload: {
      requestId: "req-network-start",
      ok: true,
      result: { command: "network", browserId: BROWSER_ID, action: "start", capturing: true },
    },
    content: [
      {
        type: "text",
        text: `Network capture started on tab ${BROWSER_ID}. Trigger the page action, then call browser_network with action list.`,
      },
    ],
  },
  {
    name: "network list with bodies",
    toolName: "browser_network",
    input: {
      browserId: BROWSER_ID,
      action: "list",
      resourceType: "fetch",
      since: 4,
      includeBodies: true,
      includeRequestBodies: true,
    },
    command: {
      command: "network",
      args: {
        browserId: BROWSER_ID,
        action: "list",
        resourceType: "fetch",
        since: 4,
        maxEntries: 50,
        includeBodies: true,
        includeRequestBodies: true,
      },
    },
    payload: {
      requestId: "req-network-list",
      ok: true,
      result: {
        command: "network",
        browserId: BROWSER_ID,
        action: "list",
        capturing: true,
        entries: [
          {
            seq: 5,
            method: "POST",
            url: "https://shop.test/api/cart",
            resourceType: "fetch",
            status: 200,
            mimeType: "application/json",
            startedAt: 1_700_000_000_000,
            durationMs: 42,
            requestHeaders: { "content-type": "application/json", authorization: "<redacted>" },
            requestBody: '{"sku":"A1","qty":1}',
            responseBody: '{"ok":true}',
          },
          {
            seq: 6,
            method: "GET",
            url: "https://shop.test/api/logo",
            resourceType: "fetch",
            status: 200,
            mimeType: "image/png",
            startedAt: 1_700_000_000_100,
            requestHeaders: {},
            responseBodyUnavailable: "binary",
          },
        ],
        cursor: 6,
        hasMore: true,
        pendingCount: 1,
        droppedCount: 0,
      },
    },
    content: [
      {
        type: "text",
        text: [
          "Captured 2 requests (cursor=6).",
          "More match: call again with since=6.",
          "1 still in flight.",
          "#5 POST 200 https://shop.test/api/cart (fetch, application/json, 42ms)",
          "  request headers: content-type: application/json; authorization: <redacted>",
          '  request body: {"sku":"A1","qty":1}',
          '  response body: {"ok":true}',
          "#6 GET 200 https://shop.test/api/logo (fetch, image/png)",
          "  response body unavailable: binary",
        ].join("\n"),
      },
    ],
  },
] satisfies Array<{
  name: string;
  toolName: string;
  input: Record<string, unknown>;
  command: BrowserToolsExecuteInput["command"];
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>;
  content: PaseoToolResult["content"];
}>;

const brokerErrorCases = [
  {
    name: "typed timeout errors",
    toolName: "browser_snapshot",
    input: { browserId: BROWSER_ID },
    payload: {
      requestId: "req-timeout",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "The browser did not respond within 15000ms. Try again or check the browser host.",
        retryable: true,
      },
    },
    content: [
      {
        type: "text",
        text: "The browser did not respond within 15000ms. Try again or check the browser host.",
      },
    ],
    context: {
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
      browserId: BROWSER_ID,
    },
  },
  {
    name: "screenshot no-frame errors",
    toolName: "browser_screenshot",
    input: { browserId: BROWSER_ID },
    payload: {
      requestId: "req-no-frame",
      ok: false,
      error: {
        code: "screenshot_no_frame",
        message: "The tab has not painted yet. Retry the screenshot.",
        retryable: true,
      },
    },
    content: [
      {
        type: "text",
        text: "The tab has not painted yet. Retry the screenshot.",
      },
    ],
    context: {
      agentId: "agent-1",
      cwd: "/repo",
      workspaceId: "wks_workspace_a",
      browserId: BROWSER_ID,
    },
  },
] satisfies Array<{
  name: string;
  toolName: string;
  input: Record<string, unknown>;
  payload: Extract<BrowserToolsResponsePayload, { ok: false }>;
  content: PaseoToolResult["content"];
  context: Record<string, unknown>;
}>;

describe("registerBrowserTools", () => {
  test("registers the kept browser automation tools only", () => {
    const harness = new BrowserToolHarness();

    expect(harness.toolNames()).toEqual([
      "browser_list_tabs",
      "browser_new_tab",
      "browser_snapshot",
      "browser_read",
      "browser_click",
      "browser_fill",
      "browser_wait",
      "browser_find",
      "browser_type",
      "browser_keypress",
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_screenshot",
      "browser_upload",
      "browser_hover",
      "browser_select",
      "browser_drag",
      "browser_logs",
      "browser_network",
      "browser_evaluate",
      "browser_scroll",
      "browser_resize",
      "browser_close_tab",
      "browser_styles",
    ]);
  });

  test("rejects unknown parameters and names the right one", () => {
    const harness = new BrowserToolHarness();

    const screenshot = harness.validate("browser_screenshot", {
      browserId: BROWSER_ID,
      path: "/tmp/shot.png",
    });
    const wait = harness.validate("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      timeout: 1000,
    });

    expect(screenshot.success).toBe(false);
    expect(screenshot.error?.issues[0]?.message).toBe(
      'browser_screenshot does not take "path". Use path → savePath. Parameters: browserId, fullPage, ref, savePath.',
    );
    expect(wait.success).toBe(false);
    expect(wait.error?.issues[0]?.message).toContain("timeout → timeoutMs");
  });

  test("logs passes level and summarizes errors, earlier pages, and failed requests", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-logs",
      ok: true,
      result: {
        command: "logs",
        browserId: BROWSER_ID,
        console: [
          { level: "error", message: "boom", timestamp: 1, previousPage: true },
          { level: "error", message: "boom", timestamp: 2 },
        ],
        network: [{ url: "https://a.test/x", status: 404, startTime: 0, duration: 1 }],
      },
    });

    const response = await harness.execute("browser_logs", {
      browserId: BROWSER_ID,
      level: "error",
    });

    expect(harness.broker.calls.at(-1)?.command).toEqual({
      command: "logs",
      args: { browserId: BROWSER_ID, maxEntries: 50, level: "error" },
    });
    expect(response.content[0]).toEqual({
      type: "text",
      text: "Read 2 console logs (2 errors, 1 from before the latest navigation (previousPage)) and 1 network entry (1 failed or HTTP 4xx/5xx).",
    });
  });

  test("styles renders rules with sources, flags, and computed values", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-styles",
      ok: true,
      result: {
        command: "styles",
        browserId: BROWSER_ID,
        ref: "@e3",
        element: "h2.title",
        rules: [
          {
            selector: ".card .title",
            source: "https://cdn.test/app.css",
            line: 12,
            conditions: ["@media (max-width: 768px)"],
            declarations: [{ name: "font-size", value: "18px", overridden: true }],
          },
          {
            selector: "h2",
            inheritedFrom: "div.card",
            declarations: [{ name: "color", value: "gray", important: true }],
          },
        ],
        computed: { "font-size": "16px" },
        userAgentRules: 2,
        truncated: false,
      },
    });

    const response = await harness.execute("browser_styles", {
      browserId: BROWSER_ID,
      ref: "@e3",
      properties: ["font-size"],
    });

    expect(harness.broker.calls.at(-1)?.command).toEqual({
      command: "styles",
      args: { browserId: BROWSER_ID, ref: "@e3", properties: ["font-size"], maxRules: 30 },
    });
    expect(response.content[0]).toEqual({
      type: "text",
      text: [
        "Styles of h2.title (@e3), highest precedence first:",
        ".card .title  /* https://cdn.test/app.css:12 @media (max-width: 768px) */",
        "  font-size: 18px; [overridden]",
        "inherited from div.card: h2",
        "  color: gray !important;",
        "2 browser-default rules not listed.",
        "Computed:",
        "  font-size: 16px",
      ].join("\n"),
    });
  });

  test("screenshot rejects fullPage together with ref", async () => {
    const harness = new BrowserToolHarness();

    const response = await harness.execute("browser_screenshot", {
      browserId: BROWSER_ID,
      fullPage: true,
      ref: "@e1",
    });

    expect(response.content[0]).toMatchObject({
      text: "browser_screenshot takes fullPage or ref, not both.",
    });
    expect(harness.broker.calls).toEqual([]);
  });

  test("list tabs sends workspace in the request envelope", async () => {
    const harness = new BrowserToolHarness();

    const response = await harness.execute("browser_list_tabs", {});

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "list_tabs", args: {} },
      },
    ]);
    expect(response.content).toEqual([
      {
        type: "text",
        text: `Found 1 Paseo browser target. Use these browserId values for target-scoped browser tools.\n- browserId=${BROWSER_ID} active title="Example" url=https://example.com`,
      },
    ]);
  });

  test("list tabs explains popup ownership without implying foreground focus", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-popups",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: POPUP_BROWSER_ID,
            workspaceId: "wks_workspace_a",
            kind: "popup",
            rootBrowserId: BROWSER_ID,
            openerBrowserId: BROWSER_ID,
            url: "https://login.example.com",
            title: "Sign in",
            isActive: false,
            isLoading: false,
          },
        ],
      },
    });

    const response = await harness.execute("browser_list_tabs", {});

    expect(response.content).toEqual([
      {
        type: "text",
        text: `Found 1 Paseo browser target. Use these browserId values for target-scoped browser tools.\n- browserId=${POPUP_BROWSER_ID} popup rootBrowserId=${BROWSER_ID} openerBrowserId=${BROWSER_ID} title="Sign in" url=https://login.example.com`,
      },
    ]);
  });

  test("list tabs says how long a tab has been loading", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-loading",
      ok: true,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_ID,
            workspaceId: "wks_workspace_a",
            url: "https://slow.example.com/admin",
            title: "",
            isActive: false,
            isLoading: true,
            loadingForMs: 183_400,
          },
        ],
      },
    });

    const response = await harness.execute("browser_list_tabs", {});

    expect(response.content).toEqual([
      {
        type: "text",
        text: `Found 1 Paseo browser target. Use these browserId values for target-scoped browser tools.\n- browserId=${BROWSER_ID} loading=183s title="Untitled" url=https://slow.example.com/admin`,
      },
    ]);
  });

  test("new tab sends workspace in the request envelope", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse(newTabPayload());

    const response = await harness.execute("browser_new_tab", { url: "https://example.com" });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "new_tab", args: { url: "https://example.com" } },
      },
    ]);
    expect(response.content).toEqual([
      {
        type: "text",
        text: `Created browser tab browserId=${BROWSER_ID} url=https://example.com. Use this browserId for tab-scoped browser tools.`,
      },
    ]);
  });

  test.each([
    {
      name: "navigate accepts localhost without a scheme as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "localhost:3000" },
      expected: { browserId: BROWSER_ID, url: "http://localhost:3000" },
    },
    {
      name: "new tab accepts a domain path without a scheme as http",
      toolName: "browser_new_tab",
      input: { url: "example.com/x" },
      expected: { url: "http://example.com/x" },
    },
    {
      name: "navigate accepts a single-label host with a port as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "devbox:8080" },
      expected: { browserId: BROWSER_ID, url: "http://devbox:8080" },
    },
    {
      name: "navigate accepts an IPv6 host with a port as http",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "[::1]:5173" },
      expected: { browserId: BROWSER_ID, url: "http://[::1]:5173" },
    },
    {
      name: "navigate trims whitespace around a URL",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "  https://example.com/x  " },
      expected: { browserId: BROWSER_ID, url: "https://example.com/x" },
    },
    {
      name: "navigate keeps https URLs unchanged",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "https://example.com/x" },
      expected: { browserId: BROWSER_ID, url: "https://example.com/x" },
    },
  ])("$name", ({ toolName, input, expected }) => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate(toolName, input);

    expect(parsed).toEqual({ success: true, data: expected });
  });

  test.each([
    {
      name: "navigate rejects file URLs",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "file:///tmp/index.html" },
    },
    {
      name: "new tab rejects file URLs",
      toolName: "browser_new_tab",
      input: { url: "file:///tmp/index.html" },
    },
    {
      name: "navigate rejects invalid ports",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "devbox:99999" },
    },
    {
      name: "navigate rejects URLs with spaces",
      toolName: "browser_navigate",
      input: { browserId: BROWSER_ID, url: "dev box:8080" },
    },
  ])("$name", ({ toolName, input }) => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate(toolName, input);

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: HTTP_URL_MESSAGE })] },
    });
  });

  test("list tabs tells agents without a workspace how to proceed", async () => {
    const harness = new BrowserToolHarness({ id: "agent-1", cwd: "/repo" });

    const response = await harness.execute("browser_list_tabs", {});

    expect(harness.broker.calls).toEqual([]);
    expect(response.content).toEqual([{ type: "text", text: WORKSPACE_CONTEXT_MESSAGE }]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
      },
    });
  });

  test("new tab tells agents without a workspace how to proceed", async () => {
    const harness = new BrowserToolHarness({ id: "agent-1", cwd: "/repo" });

    const response = await harness.execute("browser_new_tab", {});

    expect(harness.broker.calls).toEqual([]);
    expect(response.content).toEqual([{ type: "text", text: WORKSPACE_CONTEXT_MESSAGE }]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
      },
    });
  });

  test("snapshot rejects calls without a browser id", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_snapshot", {});

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("snapshot rejects hallucinated browser ids", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_snapshot", { browserId: "default" });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("snapshot sends browser id in command args only", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse(snapshotPayload());

    const response = await harness.execute("browser_snapshot", { browserId: BROWSER_ID });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: { command: "snapshot", args: { browserId: BROWSER_ID } },
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: {
        command: "snapshot",
        browserId: BROWSER_ID,
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
        title: "Example",
        format: "aria-yaml",
        snapshot: '- document "Example"\n  - button "Save" [ref=@e1]',
        truncated: false,
        stats: { nodeCount: 2, refCount: 1, textLength: 50 },
      },
      context: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        browserId: BROWSER_ID,
      },
    });
  });

  test.each(routedToolCases)(
    "$name routes browser id in command args and workspace id in the envelope",
    async ({ toolName, input, command, payload, content, structuredResult }) => {
      const harness = new BrowserToolHarness();
      harness.broker.setResponse(payload);

      const response = await harness.execute(toolName, input);

      expect(harness.broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: "/repo",
          workspaceId: "wks_workspace_a",
          command,
        },
      ]);
      expect(response.content).toEqual(content);
      expect(response.structuredContent).toEqual({
        ok: payload.ok,
        result: structuredResult ?? payload.result,
        context: {
          agentId: "agent-1",
          cwd: "/repo",
          workspaceId: "wks_workspace_a",
          browserId: BROWSER_ID,
        },
      });
    },
  );

  test.each(brokerErrorCases)(
    "$name keep broker error summaries model-actionable",
    async ({ toolName, input, payload, content, context }) => {
      const harness = new BrowserToolHarness();
      harness.broker.setResponse(payload);

      const response = await harness.execute(toolName, input);

      expect(response.content).toEqual(content);
      expect(response.structuredContent).toEqual({
        ok: false,
        error: payload.error,
        context,
      });
    },
  );

  test("success responses include handled dialog metadata and a text note", async () => {
    const harness = new BrowserToolHarness();
    const payload: Extract<BrowserToolsResponsePayload, { ok: true }> = {
      requestId: "req-click",
      ok: true,
      result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
      dialogs: [
        {
          type: "confirm",
          message: "Delete item?",
          action: "dismissed",
          timestamp: 123,
        },
      ],
    };
    harness.broker.setResponse(payload);

    const response = await harness.execute("browser_click", { browserId: BROWSER_ID, ref: "@e1" });

    expect(response.content).toEqual([
      {
        type: "text",
        text: 'Clicked browser element @e1.\nHandled browser dialog: dismissed confirm "Delete item?".',
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: payload.result,
      dialogs: payload.dialogs,
      context: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        browserId: BROWSER_ID,
      },
    });
  });

  test("failure responses include handled dialog metadata and a text note", async () => {
    const harness = new BrowserToolHarness();
    const payload: Extract<BrowserToolsResponsePayload, { ok: false }> = {
      requestId: "req-wait",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Timed out waiting for browser URL: /next",
        retryable: true,
      },
      dialogs: [
        {
          type: "beforeunload",
          message: "Leave site?",
          action: "dismissed",
          timestamp: 124,
        },
      ],
    };
    harness.broker.setResponse(payload);

    const response = await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      url: "/next",
    });

    expect(response.content).toEqual([
      {
        type: "text",
        text: 'Timed out waiting for browser URL: /next\nHandled browser dialog: dismissed beforeunload "Leave site?".',
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: payload.error,
      dialogs: payload.dialogs,
      context: {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        browserId: BROWSER_ID,
      },
    });
  });

  test("wait rejects calls without a condition", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", { browserId: BROWSER_ID });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait rejects empty calls", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", {});

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: BROWSER_ID_MESSAGE })] },
    });
  });

  test("wait rejects calls with both text and url", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      url: "/ready",
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
    });
  });

  test("wait sends the text condition and extends the broker timeout", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "text" },
    });

    const response = await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      timeoutMs: 1000,
    });

    expect(harness.broker.calls).toEqual([
      {
        agentId: "agent-1",
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        timeoutMs: 2000,
        command: {
          command: "wait",
          args: { browserId: BROWSER_ID, text: "Ready", timeoutMs: 1000 },
        },
      },
    ]);
    expect(response.content).toEqual([{ type: "text", text: "Browser wait matched text." }]);
  });

  test("wait sends a selector, script, or load condition to the host", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "load" },
    });

    for (const condition of [
      { selector: "#results" },
      { script: "window.ready === true" },
      { load: "networkidle" },
    ]) {
      await harness.execute("browser_wait", { browserId: BROWSER_ID, ...condition });
    }

    expect(harness.broker.calls.map((call) => call.command)).toEqual([
      { command: "wait", args: { browserId: BROWSER_ID, selector: "#results" } },
      { command: "wait", args: { browserId: BROWSER_ID, script: "window.ready === true" } },
      { command: "wait", args: { browserId: BROWSER_ID, load: "networkidle" } },
    ]);
  });

  test("wait rejects two conditions together, new ones included", () => {
    const harness = new BrowserToolHarness();

    for (const conditions of [
      { selector: "#a", script: "true" },
      { text: "Ready", load: "load" },
      { url: "/next", selector: "#a", timeoutMs: 1000 },
    ]) {
      expect(
        harness.validate("browser_wait", { browserId: BROWSER_ID, ...conditions }),
      ).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ message: WAIT_CONDITION_MESSAGE })] },
      });
    }
  });

  test("wait with only timeoutMs pauses without calling the browser host", async () => {
    const harness = new BrowserToolHarness();

    const response = await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      timeoutMs: 20,
    });

    expect(harness.broker.calls).toEqual([]);
    expect(response.content[0]?.text).toMatch(/^Browser wait paused \d+ms\.$/);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID },
    });
  });

  test("wait clamps timeoutMs to 30 seconds instead of rejecting", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "text" },
    });

    await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      text: "Ready",
      timeoutMs: 90_000,
    });

    expect(harness.broker.calls[0]).toMatchObject({
      timeoutMs: 31_000,
      command: { args: { timeoutMs: 30_000 } },
    });
  });

  test("host timeout reasons reach the agent instead of a generic host failure", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-click",
      ok: false,
      error: {
        code: "browser_timeout",
        message: "Browser element @e3 is covered by <div#overlay.cookie-banner>.",
        retryable: true,
      },
    });

    const response = await harness.execute("browser_click", { browserId: BROWSER_ID, ref: "@e3" });

    expect(response.content).toEqual([
      { type: "text", text: "Browser element @e3 is covered by <div#overlay.cookie-banner>." },
    ]);
  });

  test("scroll defaults a missing axis to zero", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_scroll", { browserId: BROWSER_ID, deltaY: 400 });

    expect(parsed).toMatchObject({ success: true, data: { deltaX: 0, deltaY: 400 } });
  });

  test("upload accepts a single file path string", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_upload", {
      browserId: BROWSER_ID,
      ref: "@e1",
      filePaths: "/repo/a.png",
    });

    expect(parsed).toMatchObject({ success: true, data: { filePaths: ["/repo/a.png"] } });
  });

  test("logs clamps maxEntries to 200 instead of rejecting", () => {
    const harness = new BrowserToolHarness();

    const parsed = harness.validate("browser_logs", { browserId: BROWSER_ID, maxEntries: 500 });

    expect(parsed).toMatchObject({ success: true, data: { maxEntries: 200 } });
  });

  test("screenshot writes the PNG to savePath relative to the agent cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-shot-"));
    try {
      const harness = new BrowserToolHarness({
        id: "agent-1",
        cwd: dir,
        workspaceId: "wks_workspace_a",
      });
      harness.broker.setResponse({
        requestId: "req-shot",
        ok: true,
        result: {
          command: "screenshot",
          browserId: BROWSER_ID,
          mimeType: "image/png",
          dataBase64: Buffer.from("png-bytes").toString("base64"),
          width: 10,
          height: 10,
        },
      });

      const response = await harness.execute("browser_screenshot", {
        browserId: BROWSER_ID,
        savePath: "shots/home.png",
      });

      const saved = join(dir, "shots/home.png");
      expect(await readFile(saved, "utf8")).toBe("png-bytes");
      expect(response.content[0]?.text).toContain(`Saved screenshot to ${saved}.`);
      expect(response.content[1]).toMatchObject({ type: "image" });
      expect(response.structuredContent).toMatchObject({ savedPath: saved });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("screenshot savePath expands ~/ and refuses a relative path without a cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const payload = {
        requestId: "req-shot",
        ok: true,
        result: {
          command: "screenshot",
          browserId: BROWSER_ID,
          mimeType: "image/png",
          dataBase64: Buffer.from("png").toString("base64"),
          width: 1,
          height: 1,
        },
      } satisfies BrowserToolsResponsePayload;
      const withCwd = new BrowserToolHarness();
      withCwd.broker.setResponse(payload);
      await withCwd.execute("browser_screenshot", { browserId: BROWSER_ID, savePath: "~/a.png" });
      expect(await readFile(join(home, "a.png"), "utf8")).toBe("png");

      const noCwd = new BrowserToolHarness(null, "agent-1");
      noCwd.broker.setResponse(payload);
      const response = await noCwd.execute("browser_screenshot", {
        browserId: BROWSER_ID,
        savePath: "b.png",
      });
      expect(response.content[0]?.text).toContain("is relative and this agent has no cwd");
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("tab tools keep empty context when there is no caller agent", async () => {
    const harness = new BrowserToolHarness(null, null);
    harness.broker.setResponse(snapshotPayload());

    const response = await harness.execute("browser_snapshot", { browserId: BROWSER_ID });

    expect(harness.broker.calls).toEqual([
      { command: { command: "snapshot", args: { browserId: BROWSER_ID } } },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: snapshotPayload().result,
      context: { browserId: BROWSER_ID },
    });
  });

  test("navigate text carries the HTTP status and calls out error pages", async () => {
    const harness = new BrowserToolHarness();
    const navigate = async (result: Record<string, unknown>) => {
      harness.broker.setResponse({
        requestId: "req-navigate",
        ok: true,
        result: { command: "navigate", browserId: BROWSER_ID, ...result },
      } as BrowserToolsResponsePayload);
      return (
        await harness.execute("browser_navigate", { browserId: BROWSER_ID, url: "example.com" })
      ).content[0]?.text;
    };

    expect(await navigate({ url: "https://example.com/" })).toBe(
      "Navigated browser to https://example.com/.",
    );
    expect(await navigate({ url: "https://example.com/", httpStatus: 200 })).toBe(
      "Navigated to https://example.com/ (HTTP 200).",
    );
    expect(await navigate({ url: "https://example.com/gone", httpStatus: 404 })).toBe(
      "Navigated to https://example.com/gone, but the server answered HTTP 404 Not Found. The page content is the site's error page.",
    );
  });

  test("back, forward, and reload keep their text without a status and add it with one", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-back",
      ok: true,
      result: { command: "back", browserId: BROWSER_ID },
    });
    const plain = await harness.execute("browser_back", { browserId: BROWSER_ID });
    harness.broker.setResponse({
      requestId: "req-reload",
      ok: true,
      result: {
        command: "reload",
        browserId: BROWSER_ID,
        url: "https://example.com/down",
        httpStatus: 503,
        httpStatusText: "Service Unavailable",
      },
    });
    const failed = await harness.execute("browser_reload", { browserId: BROWSER_ID });

    expect(plain.content[0]?.text).toBe("Browser back complete.");
    expect(failed.content[0]?.text).toBe(
      "Browser reload complete: https://example.com/down, but the server answered HTTP 503 Service Unavailable. The page content is the site's error page.",
    );
  });

  test("read sends defaults, says when main fell back, and keeps the body out of structuredContent", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-read",
      ok: true,
      result: {
        command: "read",
        browserId: BROWSER_ID,
        url: "https://shop.example/p/1",
        title: "Tee",
        format: "markdown",
        scope: "page",
        content: 'Structured data:\n- Product: "Tee" · 7000 KRW · SoldOut\n\n# Tee',
        truncated: false,
        stats: { chars: 54, links: 0, structuredDataFound: true },
      },
    });

    const response = await harness.execute("browser_read", { browserId: BROWSER_ID });

    expect(harness.broker.calls[0]?.command).toEqual({
      command: "read",
      args: { browserId: BROWSER_ID, scope: "main", links: true, maxChars: 40_000 },
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: [
          "Title: Tee",
          "URL: https://shop.example/p/1",
          "Read: whole page (no main content detected), 54 chars.",
          "",
          'Structured data:\n- Product: "Tee" · 7000 KRW · SoldOut\n\n# Tee',
        ].join("\n"),
      },
    ]);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      result: { command: "read", scope: "page", stats: { chars: 54 } },
    });
    expect(
      (response.structuredContent as { result: Record<string, unknown> }).result.content,
    ).toBeUndefined();
  });

  test("read says when a product page was read whole instead of through Readability", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-read",
      ok: true,
      result: {
        command: "read",
        browserId: BROWSER_ID,
        url: "https://hdex.co.kr/product/889",
        title: "HDEX",
        format: "markdown",
        scope: "page",
        mainFallback: "product_page",
        content: "# 메인로고 삭스 4 color",
        truncated: false,
        stats: { chars: 4510, links: 12, structuredDataFound: true },
      },
    });

    const response = await harness.execute("browser_read", { browserId: BROWSER_ID });

    expect(response.content[0]?.text).toContain("Read: whole page (product page), 4,510 chars.");
  });

  test("wait says networkidle when that is what matched", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-wait",
      ok: true,
      result: { command: "wait", browserId: BROWSER_ID, matched: "networkidle" },
    });

    const response = await harness.execute("browser_wait", {
      browserId: BROWSER_ID,
      load: "networkidle",
    });

    expect(response.content).toEqual([{ type: "text", text: "Browser wait matched networkidle." }]);
  });

  test("read clamps maxChars to 120000 and passes a ref", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-read",
      ok: true,
      result: {
        command: "read",
        browserId: BROWSER_ID,
        url: "https://example.com",
        title: "Example",
        format: "markdown",
        scope: "ref",
        content: "x",
        truncated: true,
        stats: { chars: 200_000, links: 0, structuredDataFound: false },
      },
    });

    const response = await harness.execute("browser_read", {
      browserId: BROWSER_ID,
      ref: "@e4",
      maxChars: 500_000,
    });

    expect(harness.broker.calls[0]?.command).toEqual({
      command: "read",
      args: { browserId: BROWSER_ID, scope: "main", ref: "@e4", links: true, maxChars: 120_000 },
    });
    expect(response.content[0]?.text).toContain(
      "Read: one element, 200,000 chars, truncated to maxChars; raise maxChars (up to 120000) or read one element with ref.",
    );
  });

  test("find lists matches with refs, states, and landmarks", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-find",
      ok: true,
      result: {
        command: "find",
        browserId: BROWSER_ID,
        matches: [
          { ref: "@e12", role: "button", name: "장바구니 담기", states: [], landmark: "main" },
          {
            role: "button",
            name: "장바구니",
            states: ["disabled=true"],
            landmark: 'navigation "상단 메뉴"',
          },
        ],
        total: 3,
      },
    });

    const response = await harness.execute("browser_find", {
      browserId: BROWSER_ID,
      role: "button",
      name: "장바구니",
      limit: 2,
    });

    expect(harness.broker.calls[0]?.command).toEqual({
      command: "find",
      args: { browserId: BROWSER_ID, role: "button", name: "장바구니", exact: false, limit: 2 },
    });
    expect(response.content[0]?.text).toBe(
      [
        'Found 3 matches for role=button name~"장바구니" (showing 2; raise limit up to 50 to see more).',
        '- button "장바구니 담기" [ref=@e12] in main',
        '- button "장바구니" [disabled=true] in navigation "상단 메뉴"',
      ].join("\n"),
    );
  });

  test("find says how to proceed when nothing matches", async () => {
    const harness = new BrowserToolHarness();
    harness.broker.setResponse({
      requestId: "req-find",
      ok: true,
      result: { command: "find", browserId: BROWSER_ID, matches: [], total: 0 },
    });

    const response = await harness.execute("browser_find", {
      browserId: BROWSER_ID,
      name: "Buy",
      exact: true,
    });

    expect(response.content[0]?.text).toBe(
      'No match for name="Buy". Take a browser_snapshot to see the page\'s roles and names.',
    );
  });

  test("find requires a role or name and rejects an invalid regular expression", () => {
    const harness = new BrowserToolHarness();

    expect(harness.validate("browser_find", { browserId: BROWSER_ID })).toMatchObject({
      success: false,
      error: {
        issues: [expect.objectContaining({ message: "browser_find requires role, name, or both" })],
      },
    });
    expect(
      harness.validate("browser_find", { browserId: BROWSER_ID, name: "/[a-/i" }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["name"],
            message: expect.stringContaining("name is not a valid regular expression"),
          }),
        ],
      },
    });
    expect(
      harness.validate("browser_find", { browserId: BROWSER_ID, name: "/add|buy/i" }).success,
    ).toBe(true);
  });
});
