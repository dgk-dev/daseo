import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell, ipcMain } from "electron";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return ALLOWED_EXTERNAL_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

// Daseo delta 56: a path the agent names in the transcript opens where the owner reads it on the
// Mac. A folder opens in Finder; a page, PDF, image, media file, or office document opens in its
// macOS app (HTML in the default browser). Everything else — source, text, logs, and anything
// executable — returns "not-handled" and stays in Daseo's file pane, because the macOS defaults
// for those are wrong (.ts opens QuickTime) and an agent-named script must never run on a click.
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

export type LocalPathOpenResult = "opened" | "not-handled";

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

export async function openLocalPath(value: unknown): Promise<LocalPathOpenResult> {
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
  if (!kind) {
    return "not-handled";
  }
  const errorMessage = await shell.openPath(filePath);
  return errorMessage ? "not-handled" : "opened";
}

export function registerOpenerHandlers(): void {
  ipcMain.handle("paseo:opener:openLocalPath", (_event, value: unknown) => openLocalPath(value));
  ipcMain.handle("paseo:opener:openUrl", async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error("Unsupported external URL");
    }
    await shell.openExternal(url);
  });
}
