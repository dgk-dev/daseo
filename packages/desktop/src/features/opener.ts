import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell, ipcMain } from "electron";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

// Daseo delta 135: the one non-web link allowed, a sent Slack message's app link of exactly
// `slack://channel?team=T…&id=C…&message=<ts>[&thread_ts=<ts>]`. Keep in step with
// `isSlackAppLink` in @getpaseo/protocol/slack-app-link (this package does not depend on it).
const SLACK_APP_LINK_PREFIX = "slack://channel?";
const SLACK_APP_LINK_MAX_LENGTH = 200;
const SLACK_APP_LINK_PARAMS: Readonly<Record<string, RegExp>> = {
  team: /^[TE][A-Z0-9]{2,20}$/,
  id: /^[CDG][A-Z0-9]{2,20}$/,
  message: /^\d{10}\.\d{6}$/,
  thread_ts: /^\d{10}\.\d{6}$/,
};
const SLACK_APP_LINK_REQUIRED = ["team", "id", "message"];

export function isSlackAppLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > SLACK_APP_LINK_MAX_LENGTH) {
    return false;
  }
  if (!value.startsWith(SLACK_APP_LINK_PREFIX)) {
    return false;
  }
  const seen = new Set<string>();
  for (const pair of value.slice(SLACK_APP_LINK_PREFIX.length).split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      return false;
    }
    const key = pair.slice(0, separator);
    const pattern = SLACK_APP_LINK_PARAMS[key];
    if (!pattern || seen.has(key) || !pattern.test(pair.slice(separator + 1))) {
      return false;
    }
    seen.add(key);
  }
  return SLACK_APP_LINK_REQUIRED.every((key) => seen.has(key));
}

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    if (ALLOWED_EXTERNAL_URL_PROTOCOLS.has(url.protocol)) {
      return true;
    }
  } catch {
    return false;
  }
  return isSlackAppLink(value);
}

// Daseo delta 56: a path the agent names in the transcript opens where the owner reads it on the
// Mac. A folder opens in Finder; a page, PDF, image, media file, or office document opens in its
// macOS app (HTML in the default browser). Delta 62 (2026-10-25): everything else that exists —
// source, text, logs, bundles, and anything executable — is revealed in Finder instead of being
// handed to Daseo's file pane, because the owner asked for every path to leave the app. The
// macOS defaults for those are wrong (.ts opens QuickTime) and an agent-named script must never
// run on a click, so they are selected in Finder rather than launched. Only a path that does not
// exist returns "not-handled".
const SYSTEM_OPEN_FILE_EXTENSIONS = new Set([
  "htm",
  "html",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "heic",
  "bmp",
  "tif",
  "tiff",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mp3",
  "m4a",
  "wav",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "xlsm",
  "ppt",
  "pptx",
  "csv",
  "hwp",
  "hwpx",
  "key",
  "numbers",
  "pages",
]);

export type LocalPathOpenResult = "opened" | "revealed" | "not-handled";

export function expandLocalPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : null;
}

export function getSystemOpenKind(input: {
  filePath: string;
  isDirectory: boolean;
  isBundle: boolean;
}): "folder" | "file" | null {
  if (input.isDirectory) {
    // An app, installer, or plug-in bundle is a directory that `open` would launch.
    return input.isBundle ? null : "folder";
  }
  const extension = path.extname(input.filePath).slice(1).toLowerCase();
  return SYSTEM_OPEN_FILE_EXTENSIONS.has(extension) ? "file" : null;
}

function wantsReveal(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { reveal?: unknown }).reveal === true
  );
}

// `reveal` comes from a transcript link with a line reference (`report.pdf:3`): the owner meant a
// place in the file, which no Mac app opens to, so the file is selected in Finder (delta 62).
export async function openLocalPath(
  value: unknown,
  options?: unknown,
): Promise<LocalPathOpenResult> {
  if (typeof value !== "string") {
    return "not-handled";
  }
  const filePath = expandLocalPath(value);
  if (!filePath) {
    return "not-handled";
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(filePath)).isDirectory();
  } catch {
    return "not-handled";
  }
  const kind = getSystemOpenKind({
    filePath,
    isDirectory,
    isBundle: isDirectory && existsSync(path.join(filePath, "Contents", "Info.plist")),
  });
  if (!kind || (kind === "file" && wantsReveal(options))) {
    shell.showItemInFolder(filePath);
    return "revealed";
  }
  const errorMessage = await shell.openPath(filePath);
  if (!errorMessage) {
    return "opened";
  }
  shell.showItemInFolder(filePath);
  return "revealed";
}

export function registerOpenerHandlers(): void {
  ipcMain.handle("paseo:opener:openLocalPath", (_event, value: unknown, options: unknown) =>
    openLocalPath(value, options),
  );
  ipcMain.handle("paseo:opener:openUrl", async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error("Unsupported external URL");
    }
    await shell.openExternal(url);
  });
}
