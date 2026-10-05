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
  BrowserAutomationNetworkActionSchema,
  BrowserAutomationNetworkResourceTypeSchema,
  BrowserAutomationReadScopeSchema,
  BrowserAutomationWaitLoadStateSchema,
  type BrowserAutomationCapturedRequest,
  type BrowserAutomationFindResult,
  type BrowserAutomationNetworkResult,
  type BrowserAutomationReadResult,
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
const BrowserWaitInputSchema = z
  .object({
    text: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    load: BrowserAutomationWaitLoadStateSchema.optional(),
    timeoutMs: BrowserWaitTimeoutInputSchema.optional(),
    browserId: BrowserAutomationBrowserIdSchema,
  })
  .refine(
    (input) => {
      const conditions = countWaitConditions(input);
      return conditions === 1 || (conditions === 0 && Boolean(input.timeoutMs));
    },
    {
      message:
        "browser_wait requires one condition (text, url, selector, script, or load), or timeoutMs alone to pause",
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
const BrowserFindInputSchema = z
  .object({
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
function countWaitConditions(input: {
  text?: string;
  url?: string;
  selector?: string;
  script?: string;
  load?: string;
}): number {
  return [input.text, input.url, input.selector, input.script, input.load].filter(Boolean).length;
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
  options.registerTool(
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

  options.registerTool(
    "browser_new_tab",
    {
      title: "Create browser tab",
      description:
        "Create a new Paseo browser tab in this agent's workspace on the most recently connected browser automation host, opened in the background without switching the user's view. Pass an http(s) URL or a scheme-less host URL, which is treated as http; the returned browserId is used by tab-scoped tools.",
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

  options.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "Return a model-readable snapshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes. Same-origin iframe content appears under its iframe node, and its refs work with every tool; a cross-origin iframe shows only its src.",
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
          command: "snapshot",
          args: {
            browserId,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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

  options.registerTool(
    "browser_click",
    {
      title: "Click browser element",
      description:
        "Click an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
        button: BrowserClickButtonInputSchema.optional(),
        doubleClick: z.boolean().optional(),
        modifiers: z.array(BrowserClickModifierInputSchema).optional(),
      },
    },
    async ({ ref, browserId, button, doubleClick, modifiers }) => {
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
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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

  options.registerTool(
    "browser_wait",
    {
      title: "Wait for browser condition",
      description:
        "Wait for one condition in a Paseo browser tab: text the page contains, a URL fragment, a CSS selector that matches an element (attached, visible or not; searches same-origin iframes and open shadow roots), a JavaScript script expression or function polled until it returns a truthy value (a throw fails at once), or load: load for the load event or networkidle for no requests in flight for 500ms (long polling or streaming keeps some pages from ever going idle). Pass only timeoutMs to pause. Use browserId from browser_new_tab or browser_list_tabs; conditions wait up to 5s by default and timeoutMs is capped at 30000.",
      inputSchema: BrowserWaitInputSchema,
    },
    async ({ text, url, selector, script, load, timeoutMs, browserId }, executionContext) => {
      const context = resolveBrowserToolContext(options);
      if (countWaitConditions({ text, url, selector, script, load }) === 0) {
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
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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

  options.registerTool(
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

  options.registerTool(
    "browser_keypress",
    {
      title: "Press browser key",
      description:
        "Dispatch a keypress to an element, or to the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        key: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ key, ref, browserId }) => {
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
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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
    options.registerTool(
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

  options.registerTool(
    "browser_screenshot",
    {
      title: "Capture browser screenshot",
      description:
        "Capture a PNG screenshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page. Set savePath to also write the PNG to a file (relative paths resolve against the agent's cwd; ~/ is the home directory).",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        fullPage: z.boolean().default(false),
        savePath: z.string().trim().min(1).optional(),
      },
    },
    async ({ browserId, fullPage, savePath }) => {
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

  options.registerTool(
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
    options.registerTool(
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

  options.registerTool(
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

  options.registerTool(
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

  options.registerTool(
    "browser_logs",
    {
      title: "Read browser logs",
      description:
        "Read recent console messages and browser performance network entries for a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50. For request methods, payloads, and response bodies use browser_network.",
      inputSchema: {
        maxEntries: BrowserLogsMaxEntriesInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ maxEntries, browserId }) => {
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
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_network",
    {
      title: "Capture browser network",
      description:
        "Capture a Paseo browser tab's requests and responses. Use this to learn the site's own API calls (method, URL, payload) so you can call them directly instead of scraping. Call with action start, trigger the page action, then action list; stop when done. Capture is per tab and off until started; start clears earlier entries. list returns completed requests oldest first with a cursor: pass it as since to read only newer ones. Filter with urlIncludes, method, and resourceType (xhr, fetch, document, other); includeBodies adds response bodies and includeRequestBodies adds request payloads, each capped at 64 KB. Cookie and Authorization values and password or one-time-code form fields read <redacted>. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        action: BrowserAutomationNetworkActionSchema,
        urlIncludes: z.string().min(1).optional(),
        method: z.string().min(1).optional(),
        resourceType: BrowserAutomationNetworkResourceTypeSchema.optional(),
        since: z.number().int().nonnegative().optional(),
        maxEntries: BrowserLogsMaxEntriesInputSchema.optional(),
        includeBodies: z.boolean().optional(),
        includeRequestBodies: z.boolean().optional(),
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
    }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "network",
          args: {
            browserId,
            action,
            ...(urlIncludes ? { urlIncludes } : {}),
            ...(method ? { method } : {}),
            ...(resourceType ? { resourceType } : {}),
            ...(since !== undefined ? { since } : {}),
            maxEntries: maxEntries ?? 50,
            includeBodies: includeBodies ?? false,
            includeRequestBodies: includeRequestBodies ?? false,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate browser JavaScript",
      description:
        "Evaluate a JavaScript function in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; when ref is provided, refs come from the latest browser_snapshot and the resolved element is passed as the first argument.",
      inputSchema: {
        function: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ function: functionSource, ref, browserId }) => {
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
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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

  options.registerTool(
    "browser_resize",
    {
      title: "Resize browser viewport",
      description:
        "Resize a Paseo browser tab or parked popup viewport. A popup currently visible inside the user's pane keeps its pane bounds and reports the actual size. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    async ({ browserId, width, height }) => {
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
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
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

async function saveScreenshot(
  savePath: string,
  cwd: string | undefined,
  dataBase64: string,
): Promise<{ text: string; path?: string }> {
  const expanded =
    savePath === "~" || savePath.startsWith("~/") ? homedir() + savePath.slice(1) : savePath;
  if (!isAbsolute(expanded) && !cwd) {
    return {
      text: `Could not save the screenshot: ${savePath} is relative and this agent has no cwd.`,
    };
  }
  const target = resolveFsPath(cwd ?? "/", expanded);
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
        context,
      },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: appendDialogSummary(summarizeBrowserError(payload.error), payload.dialogs),
      },
    ],
    structuredContent: {
      ok: false,
      error: payload.error,
      ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
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
  const textContent = { type: "text" as const, text: summarizeBrowserSuccess(payload, options) };
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
  const withDialogs = (summary: string) => appendDialogSummary(summary, payload.dialogs);
  if (payload.result.command === "read") {
    return withDialogs(summarizeBrowserRead(payload.result, options.readScope ?? "main"));
  }
  if (payload.result.command === "find") {
    return withDialogs(summarizeBrowserFind(payload.result, options.findQuery));
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
    const count = payload.result.tabs.length;
    if (count === 0) {
      return "No Paseo browser tabs are open. Call browser_new_tab to create one.";
    }
    const tabLines = payload.result.tabs.map((tab) => {
      const active = tab.isActive ? " active" : "";
      const ownership =
        tab.kind === "popup"
          ? ` popup rootBrowserId=${tab.rootBrowserId ?? "unknown"} openerBrowserId=${tab.openerBrowserId ?? "unknown"}`
          : "";
      const loading = tab.isLoading ? ` ${formatTabLoading(tab.loadingForMs)}` : "";
      return `- browserId=${tab.browserId}${active}${ownership}${loading} title=${JSON.stringify(tab.title || "Untitled")} url=${tab.url}`;
    });
    return withDialogs(
      [
        `Found ${count} Paseo browser target${count === 1 ? "" : "s"}. Use these browserId values for target-scoped browser tools.`,
        ...tabLines,
      ].join("\n"),
    );
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
    return withDialogs(`Browser wait matched ${payload.result.matched}.`);
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

function appendDialogSummary(
  summary: string,
  dialogs: BrowserToolsResponsePayload["dialogs"],
): string {
  if (!dialogs || dialogs.length === 0) {
    return summary;
  }
  return `${summary}\nHandled browser dialog${dialogs.length === 1 ? "" : "s"}: ${dialogs
    .map((dialog) => `${dialog.action} ${dialog.type} ${JSON.stringify(dialog.message)}`)
    .join("; ")}.`;
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

  return null;
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

  if (result.command !== "logs") {
    return null;
  }

  const consoleCount = result.console.length;
  const networkCount = result.network.length;
  return `Read ${consoleCount} console log${consoleCount === 1 ? "" : "s"} and ${networkCount} network entr${networkCount === 1 ? "y" : "ies"}.`;
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

function summarizeBrowserControlSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
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
    return `Resized browser viewport to ${result.width}x${result.height}.`;
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
