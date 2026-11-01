import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { getDownloadableFileInfo } from "../file-explorer/service.js";
import { expandUserPath } from "../path-utils.js";
import { PreviewLinkStore, type PreviewLinkEntry } from "./link-store.js";

// Daseo delta 75: a file the owner should open anywhere — Chrome on the phone, Chrome on the
// Mac, a link pasted into a messenger — gets an https URL on the tailnet. Tailscale Serve maps
// `<baseUrl>/<token>/<name>` to this daemon's `/f/<token>/<name>`. The URL is a capability: the
// token is the only credential, and the file must sit inside the readable scope (home or temp
// space, no symlink escape, regular files only) both when the link is issued and on every read.

export interface PreviewLinkSettings {
  /** Public prefix that Tailscale Serve forwards to the daemon's `/f`, without a trailing slash. */
  baseUrl: string;
  ttlMs: number;
}

export type PreviewLinkErrorCode =
  | "not_configured"
  | "invalid_path"
  | "not_a_file"
  | "outside_scope"
  | "not_found";

export type PreviewLinkCreateResult =
  | { ok: true; url: string; expiresAt: string; fileName: string; mimeType: string }
  | { ok: false; code: PreviewLinkErrorCode; message: string };

/** How the route answers: markdown is rendered to a page, everything else is sent as it is. */
export type PreviewServing = { kind: "markdown" } | { kind: "file"; contentType: string };

export type PreviewLinkResolveResult =
  | { status: "found"; entry: PreviewLinkEntry; absolutePath: string; serving: PreviewServing }
  | { status: "expired" }
  | { status: "missing" };

const OUTSIDE_SCOPE_MESSAGE = "Access outside of workspace is not allowed";

export class PreviewLinkService {
  private settings: PreviewLinkSettings | null;
  private readonly store: PreviewLinkStore;
  private readonly logger: Logger;

  constructor(options: {
    paseoHome: string;
    settings: PreviewLinkSettings | null;
    logger: Logger;
    now?: () => number;
  }) {
    this.settings = options.settings;
    this.logger = options.logger.child({ module: "file-preview" });
    this.store = new PreviewLinkStore({
      paseoHome: options.paseoHome,
      logger: this.logger,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** Applied at startup and again by `paseo daemon reload`. */
  configure(settings: PreviewLinkSettings | null): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    return this.settings !== null;
  }

  /** The Host the tailnet proxy forwards, accepted by the preview route alongside the allowlist. */
  publicHost(): string | null {
    return this.settings ? new URL(this.settings.baseUrl).host : null;
  }

  async createLink(input: { path: string; cwd?: string }): Promise<PreviewLinkCreateResult> {
    const settings = this.settings;
    if (!settings) {
      return {
        ok: false,
        code: "not_configured",
        message:
          "Preview links are not configured on this host: set daemon.previewLinks.baseUrl in config.json.",
      };
    }
    const requested = resolveRequestedPath(input);
    if (!requested) {
      return {
        ok: false,
        code: "invalid_path",
        message: "Give an absolute path, a ~/ path, or a path relative to cwd.",
      };
    }
    const checked = await checkReadableFile(requested);
    if (!checked.ok) {
      return checked;
    }
    const issued = this.store.issue({
      absolutePath: checked.absolutePath,
      fileName: checked.fileName,
      ttlMs: settings.ttlMs,
    });
    return {
      ok: true,
      url: `${settings.baseUrl}/${issued.token}/${encodeURIComponent(checked.fileName)}`,
      expiresAt: issued.expiresAt,
      fileName: checked.fileName,
      mimeType: servedContentType(previewServing(checked.fileName, checked.detectedMimeType)),
    };
  }

  async resolve(input: { token: string; fileName: string }): Promise<PreviewLinkResolveResult> {
    // Turning the feature off stops serving links already handed out, not only new ones.
    if (!this.settings) {
      return { status: "missing" };
    }
    const lookup = this.store.lookup(input.token);
    if (lookup.status !== "found") {
      return lookup;
    }
    // The name in the URL is part of the link: a relative reference inside a served page
    // (`./img.png`) resolves to the same token with another name, and must not get this file.
    if (lookup.entry.fileName !== input.fileName) {
      return { status: "missing" };
    }
    const checked = await checkReadableFile(lookup.entry.absolutePath);
    if (!checked.ok) {
      this.logger.debug(
        { code: checked.code, fileName: lookup.entry.fileName },
        "Preview link target is no longer readable",
      );
      return { status: "missing" };
    }
    return {
      status: "found",
      entry: lookup.entry,
      absolutePath: checked.absolutePath,
      serving: previewServing(lookup.entry.fileName, checked.detectedMimeType),
    };
  }
}

function resolveRequestedPath(input: { path: string; cwd?: string }): string | null {
  const trimmed = input.path.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "~" || trimmed.startsWith("~/") || path.isAbsolute(trimmed)) {
    return expandUserPath(trimmed);
  }
  const cwd = input.cwd?.trim();
  if (!cwd) {
    return null;
  }
  const base = expandUserPath(cwd);
  return path.isAbsolute(base) ? path.resolve(base, trimmed) : null;
}

type ReadableFileCheck =
  | { ok: true; absolutePath: string; fileName: string; detectedMimeType: string }
  | { ok: false; code: PreviewLinkErrorCode; message: string };

// The scope root is the home directory, not a caller-chosen directory: the file explorer's read
// scope admits its own root, and a link that leaves the app must not admit `/etc`.
async function checkReadableFile(absolutePath: string): Promise<ReadableFileCheck> {
  try {
    const info = await getDownloadableFileInfo({ root: homedir(), relativePath: absolutePath });
    return {
      ok: true,
      absolutePath: info.absolutePath,
      fileName: info.fileName,
      detectedMimeType: info.mimeType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (message === OUTSIDE_SCOPE_MESSAGE) {
      return {
        ok: false,
        code: "outside_scope",
        message: "Only files under the home directory or the temp directory can be shared.",
      };
    }
    if (message === "Requested path is not a file" || code === "EISDIR" || code === "ELOOP") {
      return { ok: false, code: "not_a_file", message: "The path is not a regular file." };
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, code: "not_found", message: "No file exists at that path." };
    }
    throw error;
  }
}

// Chrome decides what to show from the Content-Type, so the daemon's text/binary sniff is
// refined: documents and media get their real types (Chrome renders PDF, images, audio and
// video; Android offers an installed app for the rest), and every text file is plain UTF-8 text
// so source, CSV, and logs display instead of downloading.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwp: "application/x-hwp",
  hwpx: "application/vnd.hancom.hwpx",
  key: "application/vnd.apple.keynote",
  numbers: "application/vnd.apple.numbers",
  pages: "application/vnd.apple.pages",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
};

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_PLAIN = "text/plain; charset=utf-8";
export const TEXT_HTML = "text/html; charset=utf-8";

export function previewServing(fileName: string, detectedMimeType: string): PreviewServing {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  const known = EXTENSION_CONTENT_TYPES[extension];
  if (known) {
    return { kind: "file", contentType: known };
  }
  // The daemon's sniff found binary bytes: whatever the name says, it is not text to show.
  if (detectedMimeType === "application/octet-stream") {
    return { kind: "file", contentType: detectedMimeType };
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return { kind: "markdown" };
  }
  if (HTML_EXTENSIONS.has(extension)) {
    return { kind: "file", contentType: TEXT_HTML };
  }
  if (detectedMimeType === "application/json") {
    return { kind: "file", contentType: "application/json; charset=utf-8" };
  }
  return { kind: "file", contentType: TEXT_PLAIN };
}

function servedContentType(serving: PreviewServing): string {
  return serving.kind === "markdown" ? TEXT_HTML : serving.contentType;
}
