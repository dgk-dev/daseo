import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SlackScheduledEntry } from "@getpaseo/protocol/messages";
import { isSlackAppLink } from "@getpaseo/protocol/slack-app-link";
import { buildSelfNodeCommand } from "../paseo-env.js";

/**
 * Daseo delta 135: the Slack messages David-Daniel's agents scheduled with pi-local `slack_post
 * postAt`, read for the Schedules screen. Read-only: the daemon never talks to Slack and never
 * changes a scheduled message. The list comes from pi-local's reconcile command (which checks past
 * entries against Slack and writes their outcome back to the record); when that command is missing
 * or fails, the record file is read directly. Both paths are fixed under the daemon user's home;
 * no request argument chooses what is read. The full message text never leaves this module: a
 * client gets the first line, cut to 80 characters.
 */

export const SLACK_SCHEDULED_COMMAND_RELATIVE_PATH =
  "ws/pi-local/scripts/slack-scheduled-reconcile.mjs";
export const SLACK_SCHEDULED_FILE_RELATIVE_PATH = ".pi/agent/slack-scheduled.json";

const COMMAND_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;
const COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const FIRST_LINE_MAX_CHARS = 80;
const ERROR_MAX_CHARS = 200;

const KNOWN_STATUSES = new Set(["scheduled", "sent", "cancelled", "failed", "replaced"]);

export type SlackScheduledSource = "command" | "file";

export interface SlackScheduledListResult {
  entries: SlackScheduledEntry[];
  source: SlackScheduledSource;
  fetchedAt: number;
  /** Set when the command failed and the file was read instead, or the command warned. */
  warning: string | null;
}

export interface CommandRunResult {
  stdout: string;
}

export interface SlackScheduledReaderOptions {
  logger: pino.Logger;
  homeDir?: string;
  now?: () => number;
  /** Runs the reconcile command; rejects on a non-zero exit, a timeout, or a spawn failure. */
  runCommand?: (scriptPath: string, timeoutMs: number) => Promise<CommandRunResult>;
  readTextFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
}

function defaultRunCommand(scriptPath: string, timeoutMs: number): Promise<CommandRunResult> {
  // The daemon's own Node (Electron as Node in the packaged app): a GUI-launched daemon has no
  // reliable `node` on PATH.
  const command = buildSelfNodeCommand([scriptPath, "--json"]);
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      command.args,
      {
        env: command.env,
        timeout: timeoutMs,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncate(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : value;
}

/** The first non-empty line of a message, cut to 80 characters. */
export function slackFirstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return truncate(line ?? "", FIRST_LINE_MAX_CHARS);
}

/**
 * The sent message's links: the https permalink, and the Slack app link pi-local builds next to
 * it. Only an https permalink and an app link of the exact shape `isSlackAppLink` accepts leave
 * the daemon; anything else is dropped (without an app link the app opens the permalink).
 */
function messageLinks(raw: Record<string, unknown>): {
  permalink: string | null;
  appLink: string | null;
} {
  const permalink = optionalString(raw.permalink);
  const appLink = optionalString(raw.appLink);
  return {
    permalink: permalink && permalink.startsWith("https://") ? permalink : null,
    appLink: appLink && isSlackAppLink(appLink) ? appLink : null,
  };
}

/**
 * One record entry (from the command's JSON or the file) in the wire shape. An entry without an
 * id or a post time is dropped. A `scheduled` entry whose time has passed reads as `unverified`:
 * nothing has confirmed yet whether Slack sent it.
 */
export function normalizeSlackScheduledEntry(
  raw: unknown,
  now: number,
): SlackScheduledEntry | null {
  if (!isRecord(raw)) return null;
  const id = optionalString(raw.id);
  const postAt = optionalNumber(raw.postAt);
  if (!id || postAt === null) return null;

  const rawStatus = optionalString(raw.status);
  let status = rawStatus && KNOWN_STATUSES.has(rawStatus) ? rawStatus : "scheduled";
  if (status === "scheduled" && postAt * 1000 <= now) {
    status = "unverified";
  }

  let firstLine = "";
  if (typeof raw.firstLine === "string") {
    firstLine = slackFirstLine(raw.firstLine);
  } else if (typeof raw.text === "string") {
    firstLine = slackFirstLine(raw.text);
  }

  const channel = optionalString(raw.channel) ?? "";
  const toLabel = optionalString(raw.toLabel) ?? optionalString(raw.to) ?? channel;
  const error = optionalString(raw.error);

  return {
    id,
    as: raw.as === "bot" ? "bot" : "me",
    toLabel,
    channel,
    postAt,
    firstLine,
    status,
    createdAt: optionalNumber(raw.createdAt) ?? 0,
    resolvedAt: optionalNumber(raw.resolvedAt),
    ...messageLinks(raw),
    error: error ? truncate(error.split(/\r?\n/)[0] ?? "", ERROR_MAX_CHARS) : null,
    replacedBy: optionalString(raw.replacedBy),
  };
}

function normalizeEntries(rawEntries: unknown[], now: number): SlackScheduledEntry[] {
  const entries: SlackScheduledEntry[] = [];
  for (const raw of rawEntries) {
    const entry = normalizeSlackScheduledEntry(raw, now);
    if (entry) entries.push(entry);
  }
  return entries;
}

export class SlackScheduledReader {
  private readonly logger: pino.Logger;
  private readonly scriptPath: string;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly runCommand: (scriptPath: string, timeoutMs: number) => Promise<CommandRunResult>;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private cached: SlackScheduledListResult | null = null;
  private inFlight: Promise<SlackScheduledListResult> | null = null;

  constructor(options: SlackScheduledReaderOptions) {
    const home = options.homeDir ?? homedir();
    this.logger = options.logger;
    this.scriptPath = join(home, SLACK_SCHEDULED_COMMAND_RELATIVE_PATH);
    this.filePath = join(home, SLACK_SCHEDULED_FILE_RELATIVE_PATH);
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf8"));
    this.fileExists = options.fileExists ?? defaultFileExists;
  }

  /** The list, at most 60 s old. Concurrent callers share one read. */
  async list(): Promise<SlackScheduledListResult> {
    if (this.cached && this.now() - this.cached.fetchedAt < CACHE_TTL_MS) {
      return this.cached;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read()
      .then((result) => {
        this.cached = result;
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async read(): Promise<SlackScheduledListResult> {
    let commandWarning: string | null = null;
    if (await this.fileExists(this.scriptPath)) {
      try {
        const { stdout } = await this.runCommand(this.scriptPath, COMMAND_TIMEOUT_MS);
        const parsed: unknown = JSON.parse(stdout);
        if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
          throw new Error("Reconcile command printed no entries list");
        }
        const now = this.now();
        return {
          entries: normalizeEntries(parsed.entries, now),
          source: "command",
          fetchedAt: now,
          warning: optionalString(parsed.warning),
        };
      } catch (error) {
        commandWarning = `Slack check failed: ${truncate(getErrorMessage(error), ERROR_MAX_CHARS)}`;
        this.logger.warn({ err: error }, "Slack scheduled reconcile command failed; reading file");
      }
    }
    return this.readFileFallback(commandWarning);
  }

  private async readFileFallback(warning: string | null): Promise<SlackScheduledListResult> {
    const now = this.now();
    if (!(await this.fileExists(this.filePath))) {
      return { entries: [], source: "file", fetchedAt: now, warning };
    }
    const parsed: unknown = JSON.parse(await this.readTextFile(this.filePath));
    if (!Array.isArray(parsed)) {
      throw new Error("Slack scheduled record is not a list");
    }
    return { entries: normalizeEntries(parsed, now), source: "file", fetchedAt: now, warning };
  }
}
