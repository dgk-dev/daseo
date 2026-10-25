import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClientDebugCollectPayload } from "@getpaseo/protocol/messages";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import type { ClientDebugBroker, ClientDebugTargetInfo } from "./broker.js";

// Daseo delta 68: `phone_logs` pulls a connected app's own logs over its existing connection
// (relay or direct), saves the full dump under $PASEO_HOME/phone-logs/ and returns the parts an
// agent reads first. No wireless ADB, no Tailscale ADB port.

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the catalog helper.
  handler: (input: any) => Promise<PaseoToolResult>,
) => void;

const DEFAULT_LOGCAT_LINES = 3000;
const DEFAULT_CONSOLE_ENTRIES = 2000;
const HIGHLIGHT_CONSOLE = 40;
const HIGHLIGHT_LOGCAT = 60;
const MAX_GREP_LINES = 200;
// threadtime: "10-26 07:12:01.123  1234  1250 E Tag: message"
const LOGCAT_WARN_OR_ERROR = /^\S+\s+\S+\s+\d+\s+\d+\s+[WEF]\s/u;

function text(value: string, isError = false): PaseoToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function stamp(at: number): string {
  return new Date(at).toISOString();
}

export function formatClientDebugDump(
  target: ClientDebugTargetInfo,
  payload: ClientDebugCollectPayload,
): string {
  const lines: string[] = [
    `# Daseo app logs`,
    `client: ${target.clientId}`,
    `platform: ${payload.platform}`,
    `appVersion: ${payload.appVersion ?? target.appVersion ?? "unknown"}`,
    `collectedAt: ${stamp(payload.collectedAt)}`,
  ];
  for (const note of payload.notes ?? []) lines.push(`note: ${note}`);
  lines.push("", `## Exit info (${payload.exitInfo?.length ?? 0})`);
  for (const exit of payload.exitInfo ?? []) {
    lines.push(
      `- ${stamp(exit.at)} ${exit.reason}${exit.processName ? ` ${exit.processName}` : ""}${
        exit.description ? `: ${exit.description}` : ""
      }`,
    );
    if (exit.trace) lines.push(exit.trace);
  }
  lines.push("", `## JS console (${payload.console.length})`);
  for (const entry of payload.console) {
    lines.push(`${stamp(entry.at)} ${entry.level.toUpperCase()} ${entry.message}`);
  }
  lines.push("", "## Android logcat (own app only)");
  lines.push(payload.logcat ?? "(none)");
  return `${lines.join("\n")}\n`;
}

export function summarizeClientDebugDump(input: {
  path: string;
  target: ClientDebugTargetInfo;
  payload: ClientDebugCollectPayload;
  grep?: string;
}): string {
  const { payload, target } = input;
  const logcatLines = payload.logcat ? payload.logcat.split("\n").filter(Boolean) : [];
  const out: string[] = [
    `Saved full dump: ${input.path}`,
    `App ${payload.platform} ${payload.appVersion ?? target.appVersion ?? ""} (client ${target.clientId}), collected ${stamp(payload.collectedAt)}.`,
    `Console entries: ${payload.console.length}. Logcat lines: ${logcatLines.length}. Exit records: ${payload.exitInfo?.length ?? 0}.`,
  ];
  for (const note of payload.notes ?? []) out.push(`Note: ${note}`);
  if (input.grep) {
    const needle = input.grep.toLowerCase();
    const consoleHits = payload.console
      .filter((entry) => entry.message.toLowerCase().includes(needle))
      .map((entry) => `[console ${stamp(entry.at)} ${entry.level}] ${entry.message}`);
    const logcatHits = logcatLines.filter((line) => line.toLowerCase().includes(needle));
    const hits = [...consoleHits, ...logcatHits.map((line) => `[logcat] ${line}`)];
    out.push("", `Lines matching "${input.grep}" (${hits.length}, last ${MAX_GREP_LINES}):`);
    out.push(...hits.slice(-MAX_GREP_LINES));
    return out.join("\n");
  }
  if (payload.exitInfo?.length) {
    out.push("", "Previous exits:");
    for (const exit of payload.exitInfo) {
      out.push(
        `- ${stamp(exit.at)} ${exit.reason}${exit.description ? `: ${exit.description}` : ""}`,
      );
    }
  }
  const consoleIssues = payload.console.filter(
    (entry) => entry.level === "error" || entry.level === "warn",
  );
  out.push(
    "",
    `Console errors and warnings (last ${HIGHLIGHT_CONSOLE} of ${consoleIssues.length}):`,
  );
  out.push(
    ...consoleIssues
      .slice(-HIGHLIGHT_CONSOLE)
      .map((entry) => `${stamp(entry.at)} ${entry.level} ${entry.message.slice(0, 500)}`),
  );
  const logcatIssues = logcatLines.filter((line) => LOGCAT_WARN_OR_ERROR.test(line));
  out.push("", `Logcat W/E/F lines (last ${HIGHLIGHT_LOGCAT} of ${logcatIssues.length}):`);
  out.push(...logcatIssues.slice(-HIGHLIGHT_LOGCAT).map((line) => line.slice(0, 500)));
  out.push("", "Read the saved file for everything, or call again with grep to filter.");
  return out.join("\n");
}

function dumpPath(paseoHome: string, payload: ClientDebugCollectPayload): string {
  const directory = join(paseoHome, "phone-logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = new Date(payload.collectedAt).toISOString().replace(/[:.]/g, "-");
  return join(directory, `${name}-${payload.platform}.log`);
}

export function registerClientDebugTools(options: {
  registerTool: RegisterTool;
  broker: ClientDebugBroker;
  paseoHome?: string;
}): void {
  options.registerTool(
    "phone_logs",
    {
      title: "Read phone app logs",
      description:
        "Pull the Daseo app's own logs from a connected phone over its existing connection (no wireless ADB): the JS console ring (every level), on Android the app's own logcat (main/system/crash, every Daseo process) and previous process exits with ANR traces. Saves the full dump under ~/.paseo/phone-logs/ and returns errors, warnings, and exits. Pass grep to filter all lines by text, list to see connected apps, clientId to pick one (default: the most recently connected phone). The app must be open or recently backgrounded with its connection alive.",
      inputSchema: {
        list: z.boolean().optional(),
        clientId: z.string().min(1).optional(),
        maxLogcatLines: z.number().int().min(0).max(20000).optional(),
        maxConsoleEntries: z.number().int().min(0).max(5000).optional(),
        grep: z.string().min(1).max(200).optional(),
      },
    },
    async ({ list, clientId, maxLogcatLines, maxConsoleEntries, grep }) => {
      if (list) {
        const targets = options.broker.list();
        if (targets.length === 0) return text("No connected app can send logs.");
        return text(
          targets
            .map(
              (target) =>
                `${target.clientId} ${target.platform} ${target.appVersion ?? ""} connected ${stamp(target.connectedAt)}`,
            )
            .join("\n"),
        );
      }
      const result = await options.broker.collect({
        ...(clientId ? { clientId } : {}),
        maxLogcatLines: maxLogcatLines ?? DEFAULT_LOGCAT_LINES,
        maxConsoleEntries: maxConsoleEntries ?? DEFAULT_CONSOLE_ENTRIES,
        includeExitInfo: true,
      });
      if (!result.ok) return text(`${result.code}: ${result.message}`, true);
      const path = dumpPath(options.paseoHome ?? join(homedir(), ".paseo"), result.payload);
      writeFileSync(path, formatClientDebugDump(result.target, result.payload), { mode: 0o600 });
      return text(
        summarizeClientDebugDump({
          path,
          target: result.target,
          payload: result.payload,
          ...(grep ? { grep } : {}),
        }),
      );
    },
  );
}
