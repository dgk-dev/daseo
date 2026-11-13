import { mkdir, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolveFsPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  BROWSER_AUTOMATION_READ_DEFAULT_MAX_CHARS,
  BROWSER_AUTOMATION_READ_MAX_CHARS,
  BrowserAutomationBrowserIdSchema,
  BrowserAutomationConsoleLevelSchema,
  BrowserAutomationNetworkActionSchema,
  BrowserAutomationNetworkResourceTypeSchema,
  BrowserAutomationReadScopeSchema,
  BrowserAutomationWaitLoadStateSchema,
  type BrowserAutomationCapturedRequest,
  type BrowserAutomationConsoleLogEntry,
  type BrowserAutomationFindResult,
  type BrowserAutomationNetworkLogEntry,
  type BrowserAutomationNetworkExportResult,
  type BrowserAutomationNetworkResult,
  type BrowserAutomationReadResult,
  type BrowserAutomationPasskeysResult,
  type BrowserAutomationStylesResult,
  type BrowserAutomationTabReportResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsBroker } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

interface CallerAgentContext {
  id: string;
  cwd: string;
  workspaceId?: string;
}

export interface RegisterBrowserToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
      input: any,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  broker: Pick<BrowserToolsBroker, "execute">;
  callerAgentId?: string;
  resolveCallerAgent: () => CallerAgentContext | null;
}

const HTTP_URL_ONLY_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";
const URL_WHITESPACE_PATTERN = /\s/;
const NON_HTTP_EXPLICIT_SCHEME_PATTERN = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i;

const BrowserHttpUrlInputSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const normalized = normalizeHttpUrlInput(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: HTTP_URL_ONLY_MESSAGE,
      });
      return z.NEVER;
    }
    return normalized;
  });
const BrowserRefInputSchema = z.string().regex(/^@e\d+$/);
const BrowserClickButtonInputSchema = z.enum(["left", "right", "middle"]);
const BrowserClickModifierInputSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
const MAX_BROWSER_WAIT_MS = 30_000;
// Agents routinely ask for longer waits or pass only a duration; clamping and
// treating a lone timeoutMs as a pause costs nothing, while rejecting them
// cost a model turn each (49 duration-only and 12 over-limit calls in 60 days).
const BrowserWaitTimeoutInputSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => Math.min(value, MAX_BROWSER_WAIT_MS));
const BrowserWaitInputSchema = strictBrowserInput("browser_wait", {
  text: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  script: z.string().min(1).optional(),
  load: BrowserAutomationWaitLoadStateSchema.optional(),
  download: z.boolean().optional(),
  timeoutMs: BrowserWaitTimeoutInputSchema.optional(),
  browserId: BrowserAutomationBrowserIdSchema,
}).refine(
  (input) => {
    const conditions = countWaitConditions(input);
    return conditions === 1 || (conditions === 0 && Boolean(input.timeoutMs));
  },
  {
    message:
      "browser_wait requires one condition (text, url, selector, script, load, or download), or timeoutMs alone to pause",
  },
);
const BrowserReadMaxCharsInputSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => Math.min(value, BROWSER_AUTOMATION_READ_MAX_CHARS));
const BrowserFindLimitInputSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => Math.min(value, 50));
// `/pattern/flags` asks for a regular expression, as Lightpanda's findElement and
// Playwright's getByRole accept one. g and y are dropped: they make test() stateful.
const BROWSER_FIND_REGEX_NAME_PATTERN = /^\/(.+)\/([a-z]*)$/s;
const BrowserFindInputSchema = strictBrowserInput("browser_find", {
  browserId: BrowserAutomationBrowserIdSchema,
  role: z.string().trim().min(1).optional(),
  name: z.string().min(1).optional(),
  exact: z.boolean().optional(),
  limit: BrowserFindLimitInputSchema.optional(),
})
  .refine((input) => Boolean(input.role || input.name), {
    message: "browser_find requires role, name, or both",
  })
  .superRefine((input, context) => {
    const pattern = input.name ? parseFindNamePattern(input.name) : null;
    if (pattern && "error" in pattern) {
      context.addIssue({ code: "custom", path: ["name"], message: pattern.error });
    }
  });
// Names agents bring from Playwright, Chrome DevTools MCP, and habit. Unknown
// parameters used to be dropped without a word: a screenshot `path` returned
// success with no file written (23 times in 30 days) and a wait `timeout` waited
// the default 5 s instead (35 times).
const BROWSER_PARAMETER_HINTS: Record<string, string> = {
  path: "savePath",
  filename: "savePath",
  timeout: "timeoutMs",
  time: "timeoutMs",
  timeMs: "timeoutMs",
  fn: "function",
  expression: "function",
  code: "function",
  limit: "maxEntries",
  tabId: "browserId",
  pageId: "browserId",
  paths: "filePaths",
  selector: "ref (from browser_find) or interactive",
  filter: "ref or interactive",
  interactiveOnly: "interactive",
  element: "ref",
  target: "ref",
  uid: "ref",
};

function unknownBrowserParameterError(toolName: string, allowed: string[]) {
  return (issue: { code?: string; keys?: PropertyKey[] }): string | undefined => {
    if (issue.code !== "unrecognized_keys") {
      return undefined;
    }
    const unknown = (issue.keys ?? []).map(String);
    const hints = unknown
      .map((key) => {
        const hint = BROWSER_PARAMETER_HINTS[key];
        return hint && !allowed.includes(key) ? `${key} → ${hint}` : null;
      })
      .filter(Boolean);
    return [
      `${toolName} does not take ${unknown.map((key) => JSON.stringify(key)).join(", ")}.`,
      ...(hints.length > 0 ? [`Use ${hints.join("; ")}.`] : []),
      `Parameters: ${allowed.join(", ") || "none"}.`,
    ].join(" ");
  };
}

function strictBrowserInput<Shape extends z.ZodRawShape>(toolName: string, shape: Shape) {
  return z.strictObject(shape, {
    error: unknownBrowserParameterError(toolName, Object.keys(shape)),
  });
}

function countWaitConditions(input: {
  text?: string;
  url?: string;
  selector?: string;
  script?: string;
  load?: string;
  download?: boolean;
}): number {
  return [input.text, input.url, input.selector, input.script, input.load, input.download].filter(
    Boolean,
  ).length;
}

/** null for a plain name; the compiled pattern or why it does not compile for `/pattern/flags`. */
function parseFindNamePattern(name: string): { pattern: RegExp } | { error: string } | null {
  const match = BROWSER_FIND_REGEX_NAME_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  try {
    return { pattern: new RegExp(match[1] ?? "", (match[2] ?? "").replace(/[gy]/g, "")) };
  } catch (error) {
    return {
      error: `name is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const BrowserScrollDeltaInputSchema = z.number().default(0);
const BrowserUploadFilePathsInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));
const BrowserLogsMaxEntriesInputSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => Math.min(value, 200));

export function registerBrowserTools(options: RegisterBrowserToolsOptions): void {
  const registerTool: RegisterBrowserToolsOptions["registerTool"] = (name, config, handler) =>
    options.registerTool(
      name,
      {
        ...config,
        inputSchema:
          config.inputSchema && !(config.inputSchema instanceof z.ZodType)
            ? strictBrowserInput(name, config.inputSchema)
            : config.inputSchema,
      },
      handler,
    );

  registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List open Paseo browser targets for this agent's workspace across connected browser automation hosts. Popups include kind=popup with rootBrowserId and openerBrowserId; use every returned browserId with tab-scoped tools without bringing it to the foreground.",
      inputSchema: {},
    },
    async () => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "list_tabs",
          args: {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  registerTool(
    "browser_tab_report",
    {
      title: "Browser tab report",
      description:
        "Report every resident Paseo browser tab on this Mac, across workspaces, with its memory state: lifecycle state (active, throttled after 2 minutes unused, frozen after 15, discarded: renderer ended, reloads when next used), whether a pane, command, or phone stream holds it, minutes since last use, renderer process id and memory footprint, and what keeps its page when it is due for a discard (edited, downloading, freeze-exempt, shared-renderer, popup). Read-only: it wakes no tab and counts as no use. Tabs never shown since launch have no renderer and are not listed; browser_list_tabs lists the workspace's tabs.",
      inputSchema: {},
    },
    async () => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: { command: "tab_report", args: {} },
      });
      return browserToolResult({ payload, context });
    },
  );

  registerTool(
    "browser_new_tab",
    {
      title: "Create browser tab",
      description:
        "Create a new Paseo browser tab in this agent's workspace on the most recently connected browser automation host, opened in the background without switching the user's view. Pass an http(s) URL or a scheme-less host URL, which is treated as http; the returned browserId is used by tab-scoped tools. When your task is done, close the tabs you opened with browser_close_tab, unless the user should look at them.",
      inputSchema: {
        url: BrowserHttpUrlInputSchema.optional(),
      },
    },
    async ({ url }) => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "new_tab",
          args: url ? { url } : {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "Return a model-readable snapshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes. Same-origin iframe content appears under its iframe node, and its refs work with every tool; a cross-origin iframe shows only its src. ref (from an earlier snapshot or browser_find) shows only that element's subtree; interactive true keeps only elements with refs and the named containers around them. Both still refresh every ref on the page.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        ref: BrowserRefInputSchema.optional(),
        interactive: z.boolean().optional(),
      },
    },
    async ({ browserId, ref, interactive }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "snapshot",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            ...(interactive ? { interactive: true } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_read",
    {
      title: "Read browser page",
      description:
        "Read a Paseo browser tab as Markdown: headings, lists, tables, and links with absolute URLs; images appear as alt text only. scope main (default) picks the main content with Readability and falls back to the whole page when it finds none; page reads the whole page minus page-level navigation, header, footer, and sidebars; ref (from the latest browser_snapshot) reads one element. Same-origin iframes are included and hidden elements are left out. Product, offer, article, and organization data from JSON-LD and Open Graph or product meta tags is summarized first. links false keeps link text only. maxChars defaults to 40000 (max 120000). Use this instead of browser_evaluate to read page text; use browser_snapshot to act on elements. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        scope: BrowserAutomationReadScopeSchema.optional(),
        ref: BrowserRefInputSchema.optional(),
        links: z.boolean().optional(),
        maxChars: BrowserReadMaxCharsInputSchema.optional(),
      },
    },
    async ({ browserId, scope, ref, links, maxChars }) => {
      const context = resolveBrowserToolContext(options);
      const requestedScope = scope ?? "main";
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "read",
          args: {
            browserId,
            scope: requestedScope,
            ...(ref ? { ref } : {}),
            links: links ?? true,
            maxChars: maxChars ?? BROWSER_AUTOMATION_READ_DEFAULT_MAX_CHARS,
          },
        },
      });
      return browserToolResult({
        payload,
        context: { ...context, browserId },
        readScope: ref ? "ref" : requestedScope,
      });
    },
  );

  registerTool(
    "browser_click",
    {
      title: "Click browser element",
      description:
        "Click an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes. Page dialogs: an alert is accepted on its own and reported; a confirm or prompt is held open and the result says so (openDialog), answer it with browser_handle_dialog, or pass dialog accept or dismiss (with promptText for a prompt) to answer one this call raises at once. Never override window.confirm or window.prompt.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
        button: BrowserClickButtonInputSchema.optional(),
        doubleClick: z.boolean().optional(),
        modifiers: z.array(BrowserClickModifierInputSchema).optional(),
        ...BrowserDialogPreArmInputSchema,
      },
    },
    async ({ ref, browserId, button, doubleClick, modifiers, dialog, promptText }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "click",
          args: {
            browserId,
            ref,
            button: button ?? "left",
            doubleClick: doubleClick ?? false,
            modifiers: modifiers ?? [],
            ...dialogPreArmArgs(dialog, promptText),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_fill",
    {
      title: "Fill browser element",
      description:
        "Fill an input-like element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "fill",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_wait",
    {
      title: "Wait for browser condition",
      description:
        "Wait for one condition in a Paseo browser tab: text the page contains, a URL fragment, a CSS selector that matches an element (attached, visible or not; searches same-origin iframes and open shadow roots), a JavaScript script expression or function polled until it returns a truthy value (a throw fails at once), or load: load for the load event or networkidle for no requests in flight for 500ms (long polling or streaming keeps some pages from ever going idle), or download: true for the tab's pending or next download to finish (files an agent-driven tab downloads go to ~/Downloads/Daseo without a dialog; returns the path). Pass only timeoutMs to pause. Use browserId from browser_new_tab or browser_list_tabs; conditions wait up to 5s by default and timeoutMs is capped at 30000.",
      inputSchema: BrowserWaitInputSchema,
    },
    async (
      { text, url, selector, script, load, download, timeoutMs, browserId },
      executionContext,
    ) => {
      const context = resolveBrowserToolContext(options);
      if (countWaitConditions({ text, url, selector, script, load, download }) === 0) {
        const waitedMs = await pause(timeoutMs ?? 0, executionContext?.signal);
        return {
          content: [{ type: "text", text: `Browser wait paused ${waitedMs}ms.` }],
          structuredContent: {
            ok: true,
            result: { command: "wait", browserId, waitedMs },
            context: { ...context, browserId },
          },
        };
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        ...(timeoutMs ? { timeoutMs: timeoutMs + 1_000 } : {}),
        command: {
          command: "wait",
          args: {
            browserId,
            ...(text ? { text } : {}),
            ...(url ? { url } : {}),
            ...(selector ? { selector } : {}),
            ...(script ? { script } : {}),
            ...(load ? { load } : {}),
            ...(download ? { download } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_find",
    {
      title: "Find browser elements",
      description:
        "Find elements in a Paseo browser tab by ARIA role and accessible name, as Playwright's getByRole does. name matches case-insensitively as a substring; exact true requires the whole name; /pattern/flags is a regular expression. Actionable matches return a ref that browser_click, browser_fill, and the other ref tools accept, the same ref browser_snapshot shows for that element; other matches (headings, cells) return role, name, and text. Each match names the landmark or dialog around it, to tell same-named buttons apart. limit defaults to 10 (max 50). Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: BrowserFindInputSchema,
    },
    async ({ browserId, role, name, exact, limit }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "find",
          args: {
            browserId,
            ...(role ? { role } : {}),
            ...(name ? { name } : {}),
            exact: exact ?? false,
            limit: limit ?? 10,
          },
        },
      });
      return browserToolResult({
        payload,
        context: { ...context, browserId },
        findQuery: { role, name, exact: exact ?? false },
      });
    },
  );

  registerTool(
    "browser_type",
    {
      title: "Type into browser",
      description:
        "Type text into an element, or into the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        text: z.string(),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ text, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "type",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            text,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_keypress",
    {
      title: "Press browser key",
      description:
        "Dispatch a keypress to an element, or to the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes. Page dialogs: an alert is accepted on its own and reported; a confirm or prompt is held open and the result says so (openDialog), answer it with browser_handle_dialog, or pass dialog accept or dismiss (with promptText for a prompt) to answer one this call raises at once. Never override window.confirm or window.prompt.",
      inputSchema: {
        key: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
        ...BrowserDialogPreArmInputSchema,
      },
    },
    async ({ key, ref, browserId, dialog, promptText }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "keypress",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            key,
            ...dialogPreArmArgs(dialog, promptText),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_navigate",
    {
      title: "Navigate browser",
      description:
        "Navigate a Paseo browser tab to a URL. Use browserId from browser_new_tab or browser_list_tabs; pass an http(s) URL or a scheme-less host URL, which is treated as http.",
      inputSchema: { url: BrowserHttpUrlInputSchema, browserId: BrowserAutomationBrowserIdSchema },
    },
    async ({ url, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "navigate",
          args: {
            browserId,
            url,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_back",
      command: "back",
      title: "Browser back",
      description:
        "Go back in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_forward",
      command: "forward",
      title: "Browser forward",
      description:
        "Go forward in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_reload",
      command: "reload",
      title: "Browser reload",
      description:
        "Reload a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
  ] as const) {
    registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { browserId: BrowserAutomationBrowserIdSchema },
      },
      async ({ browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  registerTool(
    "browser_screenshot",
    {
      title: "Capture browser screenshot",
      description:
        "Capture a PNG screenshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page, or ref (from browser_snapshot or browser_find) to capture one element, scrolled into view and clipped to the viewport. Set savePath to also write the PNG to a file (relative paths resolve against the agent's cwd; ~/ is the home directory).",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        fullPage: z.boolean().default(false),
        ref: BrowserRefInputSchema.optional(),
        savePath: z.string().trim().min(1).optional(),
      },
    },
    async ({ browserId, fullPage, ref, savePath }) => {
      if (ref && fullPage) {
        return browserToolResult({
          payload: {
            requestId: "browser-tools-screenshot-args",
            ok: false,
            error: {
              code: "browser_denied",
              message: "browser_screenshot takes fullPage or ref, not both.",
              retryable: false,
            },
          },
          context: { browserId },
        });
      }
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "screenshot",
          args: {
            browserId,
            fullPage: fullPage ?? false,
            ...(ref ? { ref } : {}),
          },
        },
      });
      const result = browserToolResult({ payload, context: { ...context, browserId } });
      if (!savePath || !payload.ok || payload.result.command !== "screenshot") {
        return result;
      }
      // Agents that needed the PNG on disk (reports, before/after comparisons)
      // used to dig it out of the MCP client's spill files with a second call.
      const note = await saveScreenshot(savePath, context.cwd, payload.result.dataBase64);
      const [first, ...rest] = result.content;
      return {
        ...result,
        content: [{ ...first, type: "text", text: `${first?.text ?? ""}\n${note.text}` }, ...rest],
        structuredContent: {
          ...(result.structuredContent as Record<string, unknown>),
          ...(note.path ? { savedPath: note.path } : {}),
        },
      };
    },
  );

  registerTool(
    "browser_upload",
    {
      title: "Upload files in browser",
      description:
        "Set workspace files on a file input in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        filePaths: BrowserUploadFilePathsInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, filePaths, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "upload",
          args: {
            browserId,
            ref,
            filePaths,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_hover",
      command: "hover",
      title: "Hover browser element",
      description:
        "Hover an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    },
  ] as const) {
    registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { ref: BrowserRefInputSchema, browserId: BrowserAutomationBrowserIdSchema },
      },
      async ({ ref, browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
              ref,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  registerTool(
    "browser_select",
    {
      title: "Select browser option",
      description:
        "Set a select element in a Paseo browser tab to a value. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "select",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_drag",
    {
      title: "Drag browser element",
      description:
        "Drag one element onto another in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        sourceRef: BrowserRefInputSchema,
        targetRef: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ sourceRef, targetRef, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "drag",
          args: {
            browserId,
            sourceRef,
            targetRef,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_logs",
    {
      title: "Read browser logs",
      description:
        "Read recent console messages (uncaught errors and unhandled rejections included) and the current page's resource requests with HTTP status for a Paseo browser tab. Messages logged before the tab's latest navigation or reload are marked previousPage. level keeps that severity and above: error, warning, info, or debug (all, the default). Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50. For request methods, payloads, and response bodies use browser_network.",
      inputSchema: {
        maxEntries: BrowserLogsMaxEntriesInputSchema.optional(),
        level: BrowserAutomationConsoleLevelSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ maxEntries, level, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "logs",
          args: {
            browserId,
            maxEntries: maxEntries ?? 50,
            ...(level ? { level } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_network",
    {
      title: "Capture browser network",
      description:
        "Capture a Paseo browser tab's requests and responses to learn the site's own API calls (method, URL, payload) and call them directly instead of scraping. Call with action start, trigger the page action, then list to look or export to keep or convert; stop when done (it discards the capture). Capture is per tab and off until started; start clears earlier entries. list returns completed requests oldest first with a cursor: pass it as since to read only newer ones. Filter with urlIncludes, method, and resourceType (xhr, fetch, document, other); includeBodies adds response bodies, includeRequestBodies request payloads (each capped at 64 KB), and includeResponseHeaders response headers. Cookie and Authorization values and password or one-time-code form fields read <redacted>. export writes the capture as one sanitized HAR 1.2 file (credentials, tokens, and JWTs replaced with <redacted-N> placeholders; API response bodies whole up to 2 MB each, kept across navigations; WebSocket frames) on the machine that runs the Daseo desktop app, to path (relative paths resolve against the agent's cwd; ~/ is the home directory; default ~/Downloads/Daseo/network-<host>-<time>.har) and returns the path and a summary; the capture keeps running. export takes the same filters, bodies (api, the default, or none), and overwrite to replace an existing file. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        action: z.enum([...BrowserAutomationNetworkActionSchema.options, "export"]),
        urlIncludes: z.string().min(1).optional(),
        method: z.string().min(1).optional(),
        resourceType: BrowserAutomationNetworkResourceTypeSchema.optional(),
        since: z.number().int().nonnegative().optional(),
        maxEntries: BrowserLogsMaxEntriesInputSchema.optional(),
        includeBodies: z.boolean().optional(),
        includeRequestBodies: z.boolean().optional(),
        includeResponseHeaders: z.boolean().optional(),
        path: z.string().trim().min(1).optional(),
        bodies: z.enum(["api", "none"]).optional(),
        includeWebSocket: z.boolean().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async ({
      browserId,
      action,
      urlIncludes,
      method,
      resourceType,
      since,
      maxEntries,
      includeBodies,
      includeRequestBodies,
      includeResponseHeaders,
      path,
      bodies,
      includeWebSocket,
      overwrite,
    }) => {
      const context = resolveBrowserToolContext(options);
      const filters = {
        ...(urlIncludes ? { urlIncludes } : {}),
        ...(method ? { method } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(since !== undefined ? { since } : {}),
      };
      if (action === "export") {
        const target = path ? resolveAgentPath(path, context.cwd) : null;
        if (target && !target.ok) {
          return browserToolResult({
            payload: {
              requestId: "browser-tools-network-export-args",
              ok: false,
              error: { code: "browser_denied", message: target.message, retryable: false },
            },
            context: { ...context, browserId },
          });
        }
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          command: {
            command: "network_export",
            args: {
              browserId,
              ...(target ? { path: target.path } : {}),
              ...filters,
              bodies: bodies ?? "api",
              includeWebSocket: includeWebSocket ?? true,
              overwrite: overwrite ?? false,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "network",
          args: {
            browserId,
            action,
            ...filters,
            maxEntries: maxEntries ?? 50,
            includeBodies: includeBodies ?? false,
            includeRequestBodies: includeRequestBodies ?? false,
            ...(includeResponseHeaders ? { includeResponseHeaders: true } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_evaluate",
    {
      title: "Evaluate browser JavaScript",
      description:
        "Evaluate a JavaScript function in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; when ref is provided, refs come from the latest browser_snapshot and the resolved element is passed as the first argument. Page dialogs: an alert is accepted on its own and reported; a confirm or prompt is held open and the result says so (openDialog), answer it with browser_handle_dialog, or pass dialog accept or dismiss (with promptText for a prompt) to answer one this call raises at once. Never override window.confirm or window.prompt. A function stopped by a held dialog returns no value.",
      inputSchema: {
        function: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
        ...BrowserDialogPreArmInputSchema,
      },
    },
    async ({ function: functionSource, ref, browserId, dialog, promptText }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "evaluate",
          args: {
            browserId,
            function: functionSource,
            ...(ref ? { ref } : {}),
            ...dialogPreArmArgs(dialog, promptText),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_scroll",
    {
      title: "Scroll browser",
      description:
        "Scroll a Paseo browser tab by deltaX/deltaY CSS pixels. Use browserId from browser_new_tab or browser_list_tabs; optional ref comes from the latest browser_snapshot and centers the wheel input over that element.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        ref: BrowserRefInputSchema.optional(),
        deltaX: BrowserScrollDeltaInputSchema,
        deltaY: BrowserScrollDeltaInputSchema,
      },
    },
    async ({ browserId, ref, deltaX, deltaY }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "scroll",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            deltaX,
            deltaY,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_resize",
    {
      title: "Resize browser viewport",
      description:
        "Resize a Paseo browser tab or parked popup viewport. A popup currently visible inside the user's pane keeps its pane bounds and reports the actual size. mobile true also emulates a phone (touch, mobile viewport rules, DPR 3, an Android Chrome user agent with matching client hints); userAgent sets the user agent the tab reports, such as an in-app browser's; deviceScaleFactor overrides the DPR. Reload or navigate afterwards so the server sees the new user agent. A later resize without these fields turns the emulation off. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        mobile: z.boolean().optional(),
        userAgent: z.string().trim().min(1).max(1024).optional(),
        deviceScaleFactor: z.number().min(0.5).max(4).optional(),
      },
    },
    async ({ browserId, width, height, mobile, userAgent, deviceScaleFactor }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "resize",
          args: {
            browserId,
            width,
            height,
            ...(mobile !== undefined ? { mobile } : {}),
            ...(userAgent ? { userAgent } : {}),
            ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_close_tab",
    {
      title: "Close browser tab",
      description:
        "Close a Paseo browser tab or popup target and unregister it from the browser automation host. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "close_tab",
          args: {
            browserId,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_styles",
    {
      title: "Inspect element CSS",
      description:
        "Show the CSS behind one element in a Paseo browser tab, as the DevTools Styles pane does: matched rules highest precedence first with their selector, stylesheet URL and line, and enclosing @media/@container/@layer conditions; declarations a higher rule beats are marked overridden and unparsable ones invalid; inherited properties from ancestors; then the computed values. Browser-default rules are counted, not listed. properties narrows to those properties (a shorthand also matches its longhands). Use instead of browser_evaluate with getComputedStyle or document.styleSheets, which cannot read cross-origin sheets or tell which rule wins. ref comes from browser_snapshot or browser_find; maxRules defaults to 30.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        ref: BrowserRefInputSchema,
        properties: z.array(z.string().trim().min(1)).max(50).optional(),
        maxRules: z
          .number()
          .int()
          .positive()
          .transform((value) => Math.min(value, 100))
          .optional(),
      },
    },
    async ({ browserId, ref, properties, maxRules }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "styles",
          args: {
            browserId,
            ref,
            ...(properties && properties.length > 0 ? { properties } : {}),
            maxRules: maxRules ?? 30,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  registerTool(
    "browser_passkeys",
    {
      title: "Browser passkeys",
      description:
        "Passkeys in the Paseo browser. Every tab carries an agent-owned software authenticator: a site's passkey sign-in (navigator.credentials.get) completes at once with no Touch ID or phone when this store holds a passkey for the site, and a passkey a site registers (create) is saved here, encrypted, and served to every later tab. A site with no stored passkey gets an immediate NotAllowedError instead of a hanging prompt, so take its password, code, or 'other method' option (browser_login fills saved passwords), or register a passkey for it once while signed in and later sign-ins need nothing. action list (default) shows stored passkeys with credentialId, site and account, never keys; status says whether the tab's current site has one and whether the authenticator is installed in that tab; delete removes one by credentialId.",
      inputSchema: {
        action: z.enum(["list", "status", "delete"]).default("list"),
        browserId: BrowserAutomationBrowserIdSchema.optional(),
        credentialId: z.string().trim().min(1).optional(),
        rpId: z.string().trim().min(1).optional(),
      },
    },
    async ({ action, browserId, credentialId, rpId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "passkeys",
          args: {
            action,
            ...(browserId ? { browserId } : {}),
            ...(credentialId ? { credentialId } : {}),
            ...(rpId ? { rpId } : {}),
          },
        },
      });
      return browserToolResult({
        payload,
        context: { ...context, ...(browserId ? { browserId } : {}) },
      });
    },
  );

  registerTool(
    "browser_handle_dialog",
    {
      title: "Answer browser dialog",
      description:
        "Answer the confirm or prompt a page holds open in a Paseo browser tab (a result reported openDialog, or a tool said a dialog is open). accept true is OK, false is Cancel; promptText is what an accepted prompt returns (its default when omitted). The page then runs on; an alert it shows next is accepted and reported here, another confirm or prompt comes back as openDialog. A held dialog nobody answers is dismissed after 60 seconds and reported on the tab's next result. Alerts never need this: they are accepted on their own. While a dialog is open, tools that need the page say so at once; browser_navigate, browser_back, browser_forward, browser_reload, and browser_close_tab still work and dismiss it.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        accept: z.boolean(),
        promptText: z.string().max(10_000).optional(),
      },
    },
    async ({ browserId, accept, promptText }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "handle_dialog",
          args: { browserId, accept, ...(promptText !== undefined ? { promptText } : {}) },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );
}

const BrowserDialogPreArmInputSchema = {
  dialog: z
    .enum(["accept", "dismiss"])
    .optional()
    .describe(
      "Answer a confirm or prompt this call makes the page open at once: accept (OK) or dismiss (Cancel). Omit to have it held for browser_handle_dialog.",
    ),
  promptText: z
    .string()
    .max(10_000)
    .optional()
    .describe("Text an accepted prompt returns; the prompt's default when omitted."),
};

function dialogPreArmArgs(
  dialog: "accept" | "dismiss" | undefined,
  promptText: string | undefined,
): { dialog?: "accept" | "dismiss"; promptText?: string } {
  if (!dialog) return {};
  return { dialog, ...(promptText !== undefined ? { promptText } : {}) };
}

function resolveBrowserToolContext(options: RegisterBrowserToolsOptions): {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
} {
  const callerAgent = options.resolveCallerAgent();
  return {
    ...(options.callerAgentId ? { agentId: options.callerAgentId } : {}),
    ...(callerAgent?.cwd ? { cwd: callerAgent.cwd } : {}),
    ...(callerAgent?.workspaceId ? { workspaceId: callerAgent.workspaceId } : {}),
  };
}

/** A path an agent gave: `~/` is the home directory, a relative path resolves against its cwd. */
function resolveAgentPath(
  input: string,
  cwd: string | undefined,
): { ok: true; path: string } | { ok: false; message: string } {
  const expanded = input === "~" || input.startsWith("~/") ? homedir() + input.slice(1) : input;
  if (!isAbsolute(expanded) && !cwd) {
    return { ok: false, message: `${input} is relative and this agent has no cwd.` };
  }
  return { ok: true, path: resolveFsPath(cwd ?? "/", expanded) };
}

async function saveScreenshot(
  savePath: string,
  cwd: string | undefined,
  dataBase64: string,
): Promise<{ text: string; path?: string }> {
  const resolved = resolveAgentPath(savePath, cwd);
  if (!resolved.ok) {
    return { text: `Could not save the screenshot: ${resolved.message}` };
  }
  const target = resolved.path;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(dataBase64, "base64"));
    return { text: `Saved screenshot to ${target}.`, path: target };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `Could not save the screenshot to ${target}: ${reason}` };
  }
}

async function pause(ms: number, signal: AbortSignal | undefined): Promise<number> {
  const startedAt = Date.now();
  // An aborted pause just ends early; the elapsed time is still reported.
  await sleep(ms, undefined, { signal }).catch(() => undefined);
  return Date.now() - startedAt;
}

function normalizeHttpUrlInput(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  const explicitHttpUrl = /^https?:\/\//i.test(value);
  if (explicitHttpUrl) {
    return isValidHttpUrl(value) ? value : null;
  }

  if (URL_WHITESPACE_PATTERN.test(value) || NON_HTTP_EXPLICIT_SCHEME_PATTERN.test(value)) {
    return null;
  }

  const normalized = `http://${value}`;
  return isValidHttpUrl(normalized) ? normalized : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireWorkspaceContext(context: {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
}): PaseoToolResult | null {
  if (context.workspaceId) {
    return null;
  }

  return browserToolResult({
    payload: {
      requestId: "browser-tools-workspace-context",
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
    },
    context,
  });
}

interface BrowserFindQuery {
  role?: string;
  name?: string;
  exact: boolean;
}

interface BrowserToolSummaryOptions {
  /** What browser_read was asked for, to say when `main` fell back to the page. */
  readScope?: "main" | "page" | "ref";
  findQuery?: BrowserFindQuery;
}

function browserToolResult(
  params: {
    payload: BrowserToolsResponsePayload;
    context: { agentId?: string; cwd?: string; workspaceId?: string; browserId?: string };
  } & BrowserToolSummaryOptions,
): PaseoToolResult {
  const { payload, context } = params;
  if (payload.ok) {
    return {
      content: browserToolSuccessContent(payload, params),
      structuredContent: {
        ok: true,
        result: browserToolStructuredResult(payload.result),
        ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
        ...(payload.openDialog ? { openDialog: payload.openDialog } : {}),
        ...(payload.events ? { events: payload.events } : {}),
        context,
      },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: appendTabEvents(
          appendDialogSummary(summarizeBrowserError(payload.error), payload.dialogs),
          payload.events,
        ),
      },
    ],
    structuredContent: {
      ok: false,
      error: payload.error,
      ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
      ...(payload.openDialog ? { openDialog: payload.openDialog } : {}),
      ...(payload.events ? { events: payload.events } : {}),
      context,
    },
  };
}

function browserToolStructuredResult(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): Extract<BrowserToolsResponsePayload, { ok: true }>["result"] | Record<string, unknown> {
  if (result.command === "read") {
    // The text block already carries the page; MCP gateways forward both.
    const { content: _content, ...metadata } = result;
    return metadata;
  }
  if (result.command !== "screenshot") {
    return result;
  }

  const { dataBase64: _dataBase64, ...metadata } = result;
  return metadata;
}

function browserToolSuccessContent(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
  options: BrowserToolSummaryOptions,
): PaseoToolResult["content"] {
  const textContent = {
    type: "text" as const,
    text: appendTabEvents(
      appendOpenDialog(summarizeBrowserSuccess(payload, options), payload.openDialog),
      payload.events,
    ),
  };
  const imageContent = browserToolImageContent(payload.result);
  return imageContent ? [textContent, imageContent] : [textContent];
}

function browserToolImageContent(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): PaseoToolResult["content"][number] | null {
  if (result.command !== "screenshot") {
    return null;
  }

  return {
    type: "image",
    data: result.dataBase64,
    mimeType: result.mimeType,
  };
}

function formatTabLoading(loadingForMs: number | undefined): string {
  return loadingForMs === undefined ? "loading" : `loading=${Math.round(loadingForMs / 1000)}s`;
}

function summarizeBrowserSuccess(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
  options: BrowserToolSummaryOptions,
): string {
  const withDialogs = (summary: string) =>
    appendDialogSummary(appendLoadingNote(summary, payload.result), payload.dialogs);
  if (payload.result.command === "read") {
    return withDialogs(summarizeBrowserRead(payload.result, options.readScope ?? "main"));
  }
  if (payload.result.command === "find") {
    return withDialogs(summarizeBrowserFind(payload.result, options.findQuery));
  }
  if (payload.result.command === "styles") {
    return withDialogs(summarizeBrowserStyles(payload.result));
  }
  const controlSummary = summarizeBrowserControlSuccess(payload.result);
  if (controlSummary) {
    return withDialogs(controlSummary);
  }

  const refActionSummary = summarizeBrowserRefActionSuccess(payload.result);
  if (refActionSummary) {
    return withDialogs(refActionSummary);
  }

  const diagnosticsSummary = summarizeBrowserDiagnosticsSuccess(payload.result);
  if (diagnosticsSummary) {
    return withDialogs(diagnosticsSummary);
  }

  const keyboardSummary = summarizeBrowserKeyboardSuccess(payload.result);
  if (keyboardSummary) {
    return withDialogs(keyboardSummary);
  }

  const navigationSummary = summarizeBrowserNavigationSuccess(payload.result);
  if (navigationSummary) {
    return withDialogs(navigationSummary);
  }

  const mediaSummary = summarizeBrowserMediaSuccess(payload.result);
  if (mediaSummary) {
    return withDialogs(mediaSummary);
  }

  if (payload.result.command === "list_tabs") {
    return withDialogs(summarizeBrowserListTabs(payload.result));
  }

  if (payload.result.command === "new_tab") {
    return withDialogs(
      `Created browser tab browserId=${payload.result.browserId} url=${payload.result.url}. Use this browserId for tab-scoped browser tools.`,
    );
  }

  if (payload.result.command === "snapshot") {
    return withDialogs(
      [
        `Snapshot captured ${payload.result.stats.nodeCount} node${payload.result.stats.nodeCount === 1 ? "" : "s"} with ${payload.result.stats.refCount} ref${payload.result.stats.refCount === 1 ? "" : "s"}.`,
        `Title: ${payload.result.title || "Untitled"}`,
        `URL: ${payload.result.url}`,
        "",
        payload.result.snapshot,
      ].join("\n"),
    );
  }

  if (payload.result.command === "wait") {
    return withDialogs(summarizeBrowserWait(payload.result));
  }

  return withDialogs(`Browser ${payload.result.command} complete.`);
}

function summarizeBrowserRead(
  result: BrowserAutomationReadResult,
  requestedScope: "main" | "page" | "ref",
): string {
  const source = describeReadSource(result, requestedScope);
  const shown = result.truncated
    ? `${result.stats.chars.toLocaleString("en-US")} chars, truncated to maxChars; raise maxChars (up to ${BROWSER_AUTOMATION_READ_MAX_CHARS}) or read one element with ref`
    : `${result.stats.chars.toLocaleString("en-US")} chars`;
  return [
    `Title: ${result.title || "Untitled"}`,
    `URL: ${result.url}`,
    `Read: ${source}, ${shown}.`,
    "",
    result.content,
  ].join("\n");
}

function describeReadSource(
  result: BrowserAutomationReadResult,
  requestedScope: "main" | "page" | "ref",
): string {
  if (result.scope === "ref") {
    return "one element";
  }
  if (result.scope === "main") {
    return "main content (Readability)";
  }
  if (result.mainFallback === "product_page") {
    return "whole page (product page)";
  }
  return requestedScope === "main" ? "whole page (no main content detected)" : "whole page";
}

function summarizeBrowserPasskeys(result: BrowserAutomationPasskeysResult): string {
  const lines: string[] = [];
  if (result.action === "status" && result.tab) {
    const site = result.tab.host
      ? `this tab's site ${result.tab.host}`
      : "this tab (not an HTTP page)";
    lines.push(
      result.tab.installed
        ? `Software passkey authenticator is installed in the tab.`
        : `Software passkey authenticator is not installed in the tab (install failed or pending).`,
    );
    lines.push(
      result.passkeys.length === 0
        ? `No stored passkey for ${site}: a passkey prompt there fails at once, so use the site's password, code, or other sign-in method.`
        : `${result.passkeys.length} stored passkey${result.passkeys.length === 1 ? "" : "s"} for ${site}; its passkey sign-in completes without any prompt.`,
    );
  } else if (result.action === "delete") {
    lines.push(result.deleted ? "Passkey deleted." : "No stored passkey had that credentialId.");
  }
  if (result.action !== "status" || result.passkeys.length > 0) {
    lines.push(
      result.passkeys.length === 0
        ? "No stored passkeys."
        : `${result.passkeys.length} stored passkey${result.passkeys.length === 1 ? "" : "s"}:`,
    );
    for (const passkey of result.passkeys) {
      const account = passkey.userName ?? passkey.userDisplayName ?? "(no account name)";
      const used = passkey.lastUsedAt ? `last used ${passkey.lastUsedAt}` : "never used";
      lines.push(
        `  ${passkey.rpId}  ${account}  credentialId=${passkey.credentialId}  created ${passkey.createdAt}, ${used}`,
      );
    }
  }
  lines.push(
    `Store: ${result.storage.path} (${result.storage.encrypted ? "private keys encrypted with the OS keychain-backed key" : "not encrypted: OS encryption unavailable"}).`,
  );
  return lines.join("\n");
}

function summarizeBrowserStyles(result: BrowserAutomationStylesResult): string {
  const lines = [`Styles of ${result.element} (${result.ref}), highest precedence first:`];
  if (result.rules.length === 0) {
    lines.push("No author rules set any of these properties.");
  }
  for (const rule of result.rules) {
    const where = [
      rule.source ? `${rule.source}${rule.line ? `:${rule.line}` : ""}` : undefined,
      ...(rule.conditions ?? []),
    ].filter(Boolean);
    const inherited = rule.inheritedFrom ? `inherited from ${rule.inheritedFrom}: ` : "";
    lines.push(
      `${inherited}${rule.selector}${where.length > 0 ? `  /* ${where.join(" ")} */` : ""}`,
    );
    for (const declaration of rule.declarations) {
      const flags = [
        ...(declaration.overridden ? ["overridden"] : []),
        ...(declaration.invalid ? ["invalid"] : []),
      ];
      lines.push(
        `  ${declaration.name}: ${declaration.value}${declaration.important ? " !important" : ""};${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`,
      );
    }
  }
  if (result.truncated) {
    lines.push("More rules match; raise maxRules or pass properties.");
  }
  if (result.userAgentRules > 0) {
    lines.push(
      `${result.userAgentRules} browser-default rule${result.userAgentRules === 1 ? "" : "s"} not listed.`,
    );
  }
  const computed = Object.entries(result.computed);
  if (computed.length > 0) {
    lines.push("Computed:", ...computed.map(([name, value]) => `  ${name}: ${value}`));
  }
  return lines.join("\n");
}

function describeFindQuery(query: BrowserFindQuery | undefined): string {
  if (!query) {
    return "the query";
  }
  const parts = [
    ...(query.role ? [`role=${query.role}`] : []),
    ...(query.name ? [`name${query.exact ? "=" : "~"}${JSON.stringify(query.name)}`] : []),
  ];
  return parts.join(" ");
}

function summarizeBrowserFind(
  result: BrowserAutomationFindResult,
  query: BrowserFindQuery | undefined,
): string {
  const description = describeFindQuery(query);
  if (result.total === 0) {
    return `No match for ${description}. Take a browser_snapshot to see the page's roles and names.`;
  }
  const shown =
    result.matches.length < result.total
      ? ` (showing ${result.matches.length}; raise limit up to 50 to see more)`
      : "";
  const lines = result.matches.map((match) => {
    const attributes = [...match.states, ...(match.ref ? [`ref=${match.ref}`] : [])];
    const name = match.name ? ` ${JSON.stringify(match.name)}` : "";
    const suffix = attributes.length > 0 ? ` [${attributes.join(" ")}]` : "";
    const landmark = match.landmark ? ` in ${match.landmark}` : "";
    const text = match.text ? `: ${JSON.stringify(match.text)}` : "";
    return `- ${match.role}${name}${suffix}${landmark}${text}`;
  });
  return [
    `Found ${result.total} match${result.total === 1 ? "" : "es"} for ${description}${shown}.`,
    ...lines,
  ].join("\n");
}

/** Delta 92: one line per thing that happened in the agent's tabs since its last call. */
function appendTabEvents(summary: string, events: BrowserToolsResponsePayload["events"]): string {
  if (!events || events.length === 0) {
    return summary;
  }
  return [summary, "Since the last browser call:", ...events.map(describeTabEvent)].join("\n");
}

type BrowserTabEvent = NonNullable<BrowserToolsResponsePayload["events"]>[number];

const TAB_EVENT_LINES: Record<BrowserTabEvent["type"], (event: BrowserTabEvent) => string> = {
  popup_opened: (event) =>
    `tab ${event.browserId} opened popup browserId=${event.popupBrowserId ?? "unknown"}${event.url ? ` url=${event.url}` : ""}`,
  tab_opened: (event) =>
    `tab ${event.browserId} opened ${event.url ?? "a page"} in a new tab (browser_list_tabs shows its browserId)`,
  tab_closed: (event) => `popup ${event.browserId} closed`,
  download_started: (event) =>
    `tab ${event.browserId} started downloading ${downloadName(event)} to ${downloadPath(event)}`,
  download_finished: (event) =>
    `tab ${event.browserId} finished downloading ${downloadName(event)} (${event.download?.receivedBytes ?? 0} bytes) to ${downloadPath(event)}`,
  download_failed: (event) =>
    `tab ${event.browserId} download of ${downloadName(event)} ended ${event.download?.state ?? "failed"}`,
};

function downloadName(event: BrowserTabEvent): string {
  return event.download?.fileName ?? "a file";
}

function downloadPath(event: BrowserTabEvent): string {
  return event.download?.path ?? "~/Downloads/Daseo";
}

function describeTabEvent(event: BrowserTabEvent): string {
  return `- ${TAB_EVENT_LINES[event.type](event)}`;
}

function summarizeBrowserWait(
  result: Extract<
    Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
    { command: "wait" }
  >,
): string {
  const download = result.download;
  return download
    ? `Download finished: ${download.fileName} (${download.receivedBytes} bytes) saved to ${download.path}.`
    : `Browser wait matched ${result.matched}.`;
}

function appendLoadingNote(
  summary: string,
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string {
  return "loading" in result && result.loading === true
    ? `${summary}\nNote: the page was still loading, so this may not show all of it yet.`
    : summary;
}

function appendDialogSummary(
  summary: string,
  dialogs: BrowserToolsResponsePayload["dialogs"],
): string {
  if (!dialogs || dialogs.length === 0) {
    return summary;
  }
  return `${summary}\nHandled browser dialog${dialogs.length === 1 ? "" : "s"}: ${dialogs
    .map((dialog) => describeHandledDialog(dialog))
    .join("; ")}.`;
}

const DIALOG_REASON_LABELS: Record<string, string> = {
  unanswered: "unanswered for 60s",
  page_left: "the page navigated away",
  person: "answered in the tab by the user",
};

function describeHandledDialog(
  dialog: NonNullable<BrowserToolsResponsePayload["dialogs"]>[number],
): string {
  const text =
    dialog.type === "prompt" && dialog.promptText !== undefined
      ? ` with ${JSON.stringify(dialog.promptText)}`
      : "";
  const reason = dialog.reason ? ` (${DIALOG_REASON_LABELS[dialog.reason] ?? dialog.reason})` : "";
  return `${dialog.action} ${dialog.type} ${JSON.stringify(dialog.message)}${text}${reason}`;
}

/** Delta 93: a confirm or prompt the page still holds open after a command that succeeded. */
function appendOpenDialog(
  summary: string,
  openDialog: BrowserToolsResponsePayload["openDialog"],
): string {
  if (!openDialog) return summary;
  const defaultText =
    openDialog.type === "prompt" && openDialog.defaultValue !== undefined
      ? ` (default ${JSON.stringify(openDialog.defaultValue)})`
      : "";
  const deadline =
    openDialog.expiresAt !== undefined
      ? ` It is dismissed in ${Math.max(0, Math.round((openDialog.expiresAt - Date.now()) / 1000))}s if unanswered.`
      : "";
  const answer =
    openDialog.type === "prompt"
      ? "browser_handle_dialog with accept true and promptText, or accept false"
      : "browser_handle_dialog with accept true or false";
  return `${summary}\nDialog open: the page shows a ${openDialog.type} ${JSON.stringify(openDialog.message)}${defaultText} and waits for an answer. Call ${answer}.${deadline}`;
}

function summarizeBrowserMediaSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "screenshot") {
    return `Captured browser screenshot (${result.width}x${result.height}).`;
  }
  if (result.command === "upload") {
    const count = result.filePaths.length;
    return `Uploaded ${count} file${count === 1 ? "" : "s"} to browser element ${result.ref}.`;
  }
  return null;
}

function summarizeBrowserKeyboardSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "type") {
    return result.ref
      ? `Typed into browser element ${result.ref}.`
      : "Typed into the focused browser element.";
  }

  if (result.command === "keypress") {
    return result.ref
      ? `Pressed ${result.key} on browser element ${result.ref}.`
      : `Pressed ${result.key} in the browser.`;
  }

  if (result.command === "handle_dialog") {
    return describeDialogAnswer(result.answered);
  }

  return null;
}

function describeDialogAnswer(
  answered: Extract<
    Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
    { command: "handle_dialog" }
  >["answered"],
): string {
  const text =
    answered.type === "prompt" && answered.promptText !== undefined
      ? ` with ${JSON.stringify(answered.promptText)}`
      : "";
  const button = answered.action === "accepted" ? "OK" : "Cancel";
  return `Answered the ${answered.type} ${JSON.stringify(answered.message)}: ${button}${text}.`;
}

function summarizeBrowserNavigationSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "navigate") {
    return result.httpStatus === undefined
      ? `Navigated browser to ${result.url}.`
      : describeNavigationStatus(
          `Navigated to ${result.url}`,
          result.httpStatus,
          result.httpStatusText,
        );
  }

  if (result.command === "back" || result.command === "forward" || result.command === "reload") {
    return result.httpStatus === undefined
      ? `Browser ${result.command} complete.`
      : describeNavigationStatus(
          `Browser ${result.command} complete: ${result.url ?? "the tab"}`,
          result.httpStatus,
          result.httpStatusText,
        );
  }

  return null;
}

// A 404 or 500 page loads like any other, so without the status an agent read
// the site's error page as the content it asked for.
function describeNavigationStatus(
  lead: string,
  httpStatus: number,
  httpStatusText: string | undefined,
): string {
  // HTTP/2 responses carry no reason phrase.
  const reason = httpStatusText || STATUS_CODES[httpStatus] || "";
  if (httpStatus >= 400) {
    return `${lead}, but the server answered HTTP ${httpStatus}${reason ? ` ${reason}` : ""}. The page content is the site's error page.`;
  }
  return `${lead} (HTTP ${httpStatus}).`;
}

function summarizeBrowserDiagnosticsSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "evaluate") {
    return [
      "Browser evaluate returned:",
      result.resultJson,
      ...(result.truncated ? ["Result was truncated."] : []),
    ].join("\n");
  }

  if (result.command === "network") {
    return summarizeBrowserNetwork(result);
  }

  if (result.command === "network_export") {
    return summarizeNetworkExport(result);
  }

  if (result.command === "passkeys") {
    return summarizeBrowserPasskeys(result);
  }

  if (result.command !== "logs") {
    return null;
  }

  const consoleCount = result.console.length;
  const networkCount = result.network.length;
  const errors = result.console.filter((entry) => entry.level === "error").length;
  const warnings = result.console.filter((entry) => entry.level === "warning").length;
  const earlier = result.console.filter((entry) => entry.previousPage).length;
  const failed = result.network.filter(
    (entry) => entry.status !== undefined && (entry.status === 0 || entry.status >= 400),
  ).length;
  const consoleDetails = [
    ...(errors > 0 ? [`${errors} error${errors === 1 ? "" : "s"}`] : []),
    ...(warnings > 0 ? [`${warnings} warning${warnings === 1 ? "" : "s"}`] : []),
    ...(earlier > 0 ? [`${earlier} from before the latest navigation (previousPage)`] : []),
  ];
  const summary = `Read ${consoleCount} console log${consoleCount === 1 ? "" : "s"}${consoleDetails.length > 0 ? ` (${consoleDetails.join(", ")})` : ""} and ${networkCount} network entr${networkCount === 1 ? "y" : "ies"}${failed > 0 ? ` (${failed} failed or HTTP 4xx/5xx)` : ""}.`;
  // The entries go in the text too: MCP clients show the model the text, and the
  // structured copy is for code (Daseo hides it from Pi to save context).
  return [
    summary,
    ...(consoleCount > 0 ? ["Console:", ...result.console.map(formatConsoleLogEntry)] : []),
    ...(networkCount > 0 ? ["Network:", ...result.network.map(formatNetworkLogEntry)] : []),
  ].join("\n");
}

function formatConsoleLogEntry(entry: BrowserAutomationConsoleLogEntry): string {
  const where = entry.source
    ? ` (${entry.source}${entry.line !== undefined ? `:${entry.line}` : ""})`
    : "";
  const earlier = entry.previousPage ? " previousPage" : "";
  return `- ${formatLogTime(entry.timestamp)} ${entry.level}${earlier}: ${entry.message}${where}`;
}

function formatNetworkLogEntry(entry: BrowserAutomationNetworkLogEntry): string {
  const details = [
    entry.type,
    `${Math.round(entry.duration)}ms`,
    entry.transferSize !== undefined ? `${entry.transferSize}B` : undefined,
  ].filter(Boolean);
  return `- ${entry.status ?? "-"}${entry.method ? ` ${entry.method}` : ""} ${entry.url} (${details.join(", ")}) start=${Math.round(entry.startTime)}`;
}

function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

function summarizeBrowserNetwork(result: BrowserAutomationNetworkResult): string {
  if (result.action === "start") {
    return `Network capture started on tab ${result.browserId}. Trigger the page action, then call browser_network with action list.`;
  }
  if (result.action === "stop") {
    return `Network capture stopped on tab ${result.browserId}; its entries were discarded.`;
  }
  const entries = result.entries ?? [];
  const lines = [
    `Captured ${entries.length} request${entries.length === 1 ? "" : "s"} (cursor=${result.cursor ?? 0}).`,
  ];
  if (result.hasMore) {
    lines.push(`More match: call again with since=${result.cursor ?? 0}.`);
  }
  if (result.pendingCount) {
    lines.push(`${result.pendingCount} still in flight.`);
  }
  if (result.droppedCount) {
    lines.push(`${result.droppedCount} older requests were dropped from the tab buffer.`);
  }
  for (const entry of entries) {
    lines.push(...formatCapturedRequest(entry));
  }
  return lines.join("\n");
}

function summarizeNetworkExport(result: BrowserAutomationNetworkExportResult): string {
  const inFlight =
    result.pendingCount > 0 ? ` ${result.pendingCount} still in flight were not included.` : "";
  if (!result.path) {
    return `Nothing to export: the capture on tab ${result.browserId} has no completed requests matching the filters, so no file was written.${inFlight}`;
  }
  const counts = (record: Record<string, number>) =>
    Object.entries(record)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
  const unavailable = counts(result.bodies.unavailable);
  const redacted = counts(result.redactions);
  const lines = [
    `Exported ${result.entries} entr${result.entries === 1 ? "y" : "ies"}${result.pages > 0 ? ` on ${result.pages} page${result.pages === 1 ? "" : "s"}` : ""} to ${result.path} (${formatByteSize(result.bytes)}), a sanitized HAR 1.2 file on the machine that runs the Daseo desktop app. The capture keeps running.`,
    `Response bodies: ${result.bodies.embedded} embedded${result.bodies.truncated > 0 ? ` (${result.bodies.truncated} cut at 2 MB)` : ""}${unavailable ? `; not in the file: ${unavailable}` : ""}.`,
    ...(result.webSockets.sockets > 0
      ? [
          `WebSockets: ${result.webSockets.sockets} with ${result.webSockets.frames} frames${result.webSockets.framesDropped > 0 ? ` (${result.webSockets.framesDropped} more not kept)` : ""}.`,
        ]
      : []),
    `Redacted: ${redacted || "nothing"}.${inFlight}${result.droppedCount > 0 ? ` ${result.droppedCount} older requests had been dropped from the tab buffer.` : ""}`,
    `Hosts: ${result.hosts.map((host) => `${host.host} ${host.requests}`).join(", ")}.`,
  ];
  return lines.join("\n");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCapturedRequest(entry: BrowserAutomationCapturedRequest): string[] {
  const outcome = entry.failed ? `failed(${entry.failed})` : String(entry.status ?? "-");
  const details = [
    entry.resourceType,
    entry.mimeType,
    entry.durationMs !== undefined ? `${entry.durationMs}ms` : undefined,
  ].filter(Boolean);
  const lines = [`#${entry.seq} ${entry.method} ${outcome} ${entry.url} (${details.join(", ")})`];
  const headers = Object.entries(entry.requestHeaders);
  if (headers.length > 0) {
    lines.push(
      `  request headers: ${headers.map(([name, value]) => `${name}: ${value}`).join("; ")}`,
    );
  }
  if (entry.requestBody !== undefined) {
    lines.push(
      `  request body${entry.requestBodyTruncated ? " (truncated)" : ""}: ${entry.requestBody}`,
    );
  }
  if (entry.responseHeaders) {
    const responseHeaders = Object.entries(entry.responseHeaders);
    lines.push(
      `  response headers: ${responseHeaders.map(([name, value]) => `${name}: ${value.replace(/\n/g, ", ")}`).join("; ")}`,
    );
  }
  if (entry.responseBody !== undefined) {
    lines.push(
      `  response body${entry.responseBodyTruncated ? " (truncated)" : ""}: ${entry.responseBody}`,
    );
  } else if (entry.responseBodyUnavailable) {
    lines.push(`  response body unavailable: ${entry.responseBodyUnavailable}`);
  }
  return lines;
}

function summarizeBrowserRefActionSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "click") {
    return `Clicked browser element ${result.ref}.`;
  }

  if (result.command === "fill") {
    return `Filled browser element ${result.ref}.`;
  }

  return null;
}

const MEMORY_PRESSURE_NAMES: Record<number, string> = { 1: "normal", 2: "warning", 4: "critical" };

function summarizeBrowserListTabs(
  result: Extract<
    Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
    { command: "list_tabs" }
  >,
): string {
  const count = result.tabs.length;
  if (count === 0) {
    return "No Paseo browser tabs are open. Call browser_new_tab to create one.";
  }
  const tabLines = result.tabs.map((tab) => {
    const active = tab.isActive ? " active" : "";
    const ownership =
      tab.kind === "popup"
        ? ` popup rootBrowserId=${tab.rootBrowserId ?? "unknown"} openerBrowserId=${tab.openerBrowserId ?? "unknown"}`
        : "";
    const loading = tab.isLoading ? ` ${formatTabLoading(tab.loadingForMs)}` : "";
    return `- browserId=${tab.browserId}${active}${ownership}${loading} title=${JSON.stringify(tab.title || "Untitled")} url=${tab.url}`;
  });
  const unseen = result.unseenOpenedByAgent;
  return [
    `Found ${count} Paseo browser target${count === 1 ? "" : "s"}. Use these browserId values for target-scoped browser tools.`,
    ...tabLines,
    ...(unseen
      ? [
          `${unseen} of these tabs you opened have not been looked at by the user; close the ones you no longer need with browser_close_tab.`,
        ]
      : []),
  ].join("\n");
}

function summarizeBrowserTabReport(result: BrowserAutomationTabReportResult): string {
  const settings = [
    describeIdleDiscardSetting(result.discardIdleAfterMinutes),
    result.pressureLevel === undefined
      ? null
      : `memory pressure ${MEMORY_PRESSURE_NAMES[result.pressureLevel] ?? result.pressureLevel}`,
  ].filter((part): part is string => part !== null);
  if (result.tabs.length === 0) {
    return ["No resident browser tabs.", ...settings].join(" ");
  }
  const totalBytes = result.tabs.reduce((sum, tab) => sum + (tab.footprintBytes ?? 0), 0);
  const header = `${result.tabs.length} resident browser tab${result.tabs.length === 1 ? "" : "s"}, ${formatMegabytes(totalBytes)} in renderers${settings.length > 0 ? ` (${settings.join("; ")})` : ""}. Largest first:`;
  const lines = [...result.tabs]
    .sort((left, right) => (right.footprintBytes ?? -1) - (left.footprintBytes ?? -1))
    .map((tab) => {
      const parts = [
        `- browserId=${tab.browserId}`,
        tab.kind === "popup" ? "popup" : null,
        tab.state,
        tab.held ? "held" : null,
        `idle=${tab.idleMinutes}m`,
        tab.footprintBytes !== undefined ? formatMegabytes(tab.footprintBytes) : null,
        tab.rendererPid !== undefined ? `pid=${tab.rendererPid}` : null,
        tab.discardBlockedBy ? `kept=${tab.discardBlockedBy}` : null,
        tab.workspaceId ? `workspace=${tab.workspaceId}` : null,
        `title=${JSON.stringify(tab.title || "Untitled")}`,
        `url=${tab.url}`,
      ];
      return parts.filter((part): part is string => part !== null).join(" ");
    });
  return [header, ...lines].join("\n");
}

function describeIdleDiscardSetting(minutes: number | undefined): string | null {
  if (minutes === undefined) return null;
  return minutes > 0
    ? `frozen tabs unused ${minutes} min are discarded`
    : "discard without memory pressure is off";
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function summarizeBrowserControlSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "tab_report") {
    return summarizeBrowserTabReport(result);
  }

  if (result.command === "select") {
    return `Selected ${result.value} in browser element ${result.ref}.`;
  }

  if (result.command === "hover") {
    return `Hovered browser element ${result.ref}.`;
  }

  if (result.command === "drag") {
    return `Dragged browser element ${result.sourceRef} to ${result.targetRef}.`;
  }

  if (result.command === "scroll") {
    return result.ref
      ? `Scrolled browser element ${result.ref} by ${result.deltaX}, ${result.deltaY}.`
      : `Scrolled browser by ${result.deltaX}, ${result.deltaY}.`;
  }

  if (result.command === "resize") {
    const emulation = result.emulation;
    if (!emulation) {
      return `Resized browser viewport to ${result.width}x${result.height}.`;
    }
    return `Resized browser viewport to ${result.width}x${result.height}, emulating ${emulation.mobile ? "a touch phone" : "a device"} at DPR ${emulation.deviceScaleFactor} with user agent ${JSON.stringify(emulation.userAgent)}. Reload so the server sees it.`;
  }

  if (result.command === "close_tab") {
    return `Closed browser tab ${result.browserId}.`;
  }

  return null;
}

function summarizeBrowserError(
  error: Extract<BrowserToolsResponsePayload, { ok: false }>["error"],
): string {
  switch (error.code) {
    case "browser_disabled":
      return "Browser tools are disabled. Enable browser tools on the host, then try again.";
    case "browser_no_host":
      return error.message;
    case "browser_timeout":
      // The host reports why it gave up (text never appeared, element covered,
      // tab still registering); the broker's own timeout says the host is silent.
      return (
        error.message ||
        "The browser did not respond before the timeout. Try again or check the browser host."
      );
    case "screenshot_no_frame":
      return error.message;
    case "browser_unsupported":
      return error.message;
    case "browser_stale_ref":
      return "That browser element reference is stale. Take a new browser snapshot and try again.";
    default:
      return error.message;
  }
}
