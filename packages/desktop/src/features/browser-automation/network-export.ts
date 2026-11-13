import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  BrowserAutomationNetworkExportCommandArgs,
  BrowserAutomationNetworkExportResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { NetworkCaptureControl } from "./network-capture.js";
import { buildHar, describeHarExport } from "./network-har.js";
import { sanitizeHar } from "./network-har-sanitize.js";

// Daseo delta 99. `browser_network` export: the desktop main process holds the capture, so it
// builds, sanitizes, and writes the HAR itself; the file never crosses IPC or the daemon socket,
// and only a short summary goes back.

/** What the export needs from the app around it. */
export interface NetworkExportEnvironment {
  /** The Daseo app version, for `log.creator`. */
  appVersion: string;
  /** Chromium's version, for `log.browser`. */
  browserVersion: string;
  /** Where a file goes when no path was given (the agent downloads folder). */
  defaultDirectory: string;
  now(): Date;
}

/** A refusal the agent can act on (existing file, directory path); not a failure of the app. */
export class NetworkExportRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NetworkExportRefusal";
  }
}

export type NetworkExportSummary = Omit<
  BrowserAutomationNetworkExportResult,
  "command" | "browserId"
>;

export async function exportNetworkCapture(input: {
  capture: NetworkCaptureControl;
  args: BrowserAutomationNetworkExportCommandArgs;
  pageUrl: string;
  environment: NetworkExportEnvironment;
}): Promise<NetworkExportSummary> {
  const { capture, args, environment } = input;
  const data = await capture.exportData();
  const { har, stats } = buildHar(data, {
    creatorVersion: environment.appVersion,
    browserVersion: environment.browserVersion,
    bodies: args.bodies,
    ...(args.urlIncludes ? { urlIncludes: args.urlIncludes } : {}),
    ...(args.method ? { method: args.method } : {}),
    ...(args.resourceType ? { resourceType: args.resourceType } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    includeWebSocket: args.includeWebSocket,
  });
  const redactions: Record<string, number> = { ...sanitizeHar(har).redactions };
  har.log.comment = describeHarExport(stats, redactions, args.bodies);
  const summary: NetworkExportSummary = {
    bytes: 0,
    entries: stats.entries,
    pages: stats.pages,
    pendingCount: stats.pendingCount,
    droppedCount: stats.droppedCount,
    skippedNonNetwork: stats.skippedNonNetwork,
    bodies: stats.bodies,
    webSockets: stats.webSockets,
    redactions,
    hosts: stats.hosts,
    ...(stats.window ? { window: stats.window } : {}),
  };
  if (stats.entries === 0) {
    return summary;
  }
  const text = `${JSON.stringify(har, null, 2)}\n`;
  const path =
    args.path ??
    (await uniqueDefaultPath(environment.defaultDirectory, input.pageUrl, environment.now()));
  await writeHarFile(path, text, args.overwrite);
  return { ...summary, path, bytes: Buffer.byteLength(text, "utf8") };
}

/** `network-<host>-<YYYYMMDD-HHmmss>.har`, with `-2`, `-3`, ... when that name is taken. */
export function defaultExportFileName(pageUrl: string, now: Date, suffix = 1): string {
  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = "";
  }
  const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "page";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `network-${safeHost}-${stamp}${suffix > 1 ? `-${suffix}` : ""}.har`;
}

async function uniqueDefaultPath(directory: string, pageUrl: string, now: Date): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(directory, defaultExportFileName(pageUrl, now, suffix));
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Writes `text` to `target` with mode 0600: parent directories are created, the bytes go to a
 * temporary file in the same directory first, and the file appears whole. An existing file is
 * replaced only with `overwrite`; a directory is never replaced.
 */
export async function writeHarFile(target: string, text: string, overwrite: boolean) {
  const existing = await stat(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing?.isDirectory()) {
    throw new NetworkExportRefusal(`${target} is a directory; give a file path ending in .har.`);
  }
  if (existing && !overwrite) {
    throw new NetworkExportRefusal(
      `${target} already exists; pass overwrite: true to replace it, or another path.`,
    );
  }
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    if (overwrite) {
      await rename(temporary, target);
      return;
    }
    // link() refuses an existing target atomically, so a file that appeared since the check
    // above is not replaced.
    try {
      await link(temporary, target);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") {
        throw new NetworkExportRefusal(
          `${target} already exists; pass overwrite: true to replace it, or another path.`,
        );
      }
      // Volumes without hard links (exFAT, some network shares).
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") {
        throw error;
      }
      if (await pathExists(target)) {
        throw new NetworkExportRefusal(
          `${target} already exists; pass overwrite: true to replace it, or another path.`,
        );
      }
      await rename(temporary, target);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
