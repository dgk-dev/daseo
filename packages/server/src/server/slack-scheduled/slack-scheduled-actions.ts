import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { SLACK_SCHEDULED_TEXT_MAX_CHARS } from "@getpaseo/protocol/slack-scheduled-limits";
import { buildSelfNodeCommand } from "../paseo-env.js";

/**
 * Daseo delta 135 (2026-11-23): the owner's own buttons on an upcoming scheduled Slack message
 * (취소, 시간 변경, 내용 수정). His press in his own app is his approval (his decision that day);
 * agents get no path here: these run only from the WebSocket requests, never from an MCP tool or a
 * CLI command. The daemon still holds no Slack token: pi-local's act script does the Slack calls.
 * The script path is fixed under the daemon user's home, the request goes on stdin (message text
 * never in argv), and the script refuses to run inside an agent session, so the agent markers are
 * dropped from its environment here. Message text is never logged.
 */

export const SLACK_SCHEDULED_ACT_RELATIVE_PATH = "ws/pi-local/scripts/slack-scheduled-act.mjs";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const ERROR_MAX_CHARS = 300;
const SCHEDULED_ID = /^Q[A-Z0-9]{6,}$/;
// The act script refuses to run while any of these is set; a daemon started from an agent shell
// (a dev daemon) would otherwise pass them on.
const AGENT_ENV_MARKERS = ["PASEO_AGENT_ID", "PI_CODING_AGENT", "CLAUDECODE"] as const;

export type SlackScheduledActRequest =
  | { action: "cancel"; id: string }
  | { action: "change"; id: string; postAt?: number; text?: string };

export interface SlackScheduledActResult {
  ok: boolean;
  newId: string | null;
  error: string | null;
}

export interface SlackScheduledActionsOptions {
  logger: pino.Logger;
  homeDir?: string;
  now?: () => number;
  /** Called after every action, success or failure, so the next list is read fresh. */
  onSettled: () => void;
  /** Runs the act script with the request on stdin; rejects on a spawn failure or a timeout. */
  runCommand?: (scriptPath: string, stdin: string, timeoutMs: number) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
}

function defaultRunCommand(scriptPath: string, stdin: string, timeoutMs: number): Promise<string> {
  const overlay = Object.fromEntries(AGENT_ENV_MARKERS.map((name) => [name, undefined]));
  const command = buildSelfNodeCommand([scriptPath], overlay);
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.command,
      command.args,
      {
        env: command.env,
        timeout: timeoutMs,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        // The script exits 2 for a request it cannot parse and still prints its answer line.
        if (error && !stdout.trim()) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(stdin);
  });
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function shorten(message: string): string {
  const line = message.split(/\r?\n/)[0] ?? "";
  return line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS - 1)}…` : line;
}

function failure(error: string): SlackScheduledActResult {
  return { ok: false, newId: null, error: shorten(error) };
}

/** Checks a request before anything runs; returns the reason it is refused, or null. */
export function validateSlackScheduledActRequest(
  request: SlackScheduledActRequest,
  nowMs: number,
): string | null {
  if (!SCHEDULED_ID.test(request.id)) return "Not a scheduled message id";
  if (request.action === "cancel") return null;
  if (request.postAt === undefined && request.text === undefined) {
    return "Give a new time, a new text, or both";
  }
  if (request.postAt !== undefined) {
    if (!Number.isInteger(request.postAt)) return "The new time is not whole Unix seconds";
    if (request.postAt * 1000 <= nowMs) return "The new time is in the past";
  }
  if (request.text !== undefined) {
    if (request.text.trim().length === 0) return "The new text is empty";
    if (Array.from(request.text).length > SLACK_SCHEDULED_TEXT_MAX_CHARS) {
      return `The new text is longer than ${SLACK_SCHEDULED_TEXT_MAX_CHARS.toLocaleString("en-US")} characters`;
    }
  }
  return null;
}

/** The act script's one answer line, or a failure saying it printed none. */
export function parseSlackScheduledActOutput(stdout: string): SlackScheduledActResult {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure("The Slack script printed no answer");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure("The Slack script printed no answer");
  }
  const body = parsed as Record<string, unknown>;
  if (body.ok === true) {
    return { ok: true, newId: typeof body.newId === "string" ? body.newId : null, error: null };
  }
  return failure(
    typeof body.error === "string" && body.error ? body.error : "The Slack change failed",
  );
}

export class SlackScheduledActions {
  private readonly logger: pino.Logger;
  private readonly scriptPath: string;
  private readonly now: () => number;
  private readonly onSettled: () => void;
  private readonly runCommand: (
    scriptPath: string,
    stdin: string,
    timeoutMs: number,
  ) => Promise<string>;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private running = false;

  constructor(options: SlackScheduledActionsOptions) {
    this.logger = options.logger;
    this.scriptPath = join(options.homeDir ?? homedir(), SLACK_SCHEDULED_ACT_RELATIVE_PATH);
    this.now = options.now ?? Date.now;
    this.onSettled = options.onSettled;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.fileExists = options.fileExists ?? defaultFileExists;
  }

  /**
   * Runs one action. One at a time: a second request while one runs is refused (two changes to
   * the same message would race on its id). Never throws.
   */
  async run(request: SlackScheduledActRequest): Promise<SlackScheduledActResult> {
    const refused = validateSlackScheduledActRequest(request, this.now());
    if (refused) return failure(refused);
    if (this.running) return failure("Another change to a scheduled message is still running");
    this.running = true;
    try {
      if (!(await this.fileExists(this.scriptPath))) {
        return failure(
          `pi-local's Slack script is not on this host (~/${SLACK_SCHEDULED_ACT_RELATIVE_PATH})`,
        );
      }
      const stdout = await this.runCommand(
        this.scriptPath,
        JSON.stringify(request),
        COMMAND_TIMEOUT_MS,
      );
      const result = parseSlackScheduledActOutput(stdout);
      this.logger.info(
        { action: request.action, id: request.id, ok: result.ok, newId: result.newId },
        "Scheduled Slack message action",
      );
      return result;
    } catch (error) {
      this.logger.warn(
        { action: request.action, id: request.id, err: getErrorMessage(error) },
        "Scheduled Slack message action failed to run",
      );
      return failure(`The Slack script did not finish: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
      this.onSettled();
    }
  }
}
