import { isAbsolutePath } from "@/utils/path";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

const FILE_PROTOCOL = "file:";
const INLINE_LINE_FRAGMENT = /^L([0-9]+)(?:C[0-9]+)?(?:-L?([0-9]+)(?:C[0-9]+)?)?$/i;
const INLINE_COLON_LINE_SUFFIX = /^(.+?):([0-9]+)(?::[0-9]+)?(?:-([0-9]+)(?::[0-9]+)?)?$/;
const INLINE_PAREN_LINE_SUFFIX = /^(.+?)\(([0-9]+)(?:,[0-9]+)?(?:-([0-9]+)(?:,[0-9]+)?)?\)$/;
const INLINE_WORD_LINE_SUFFIX = /^(.+?)\s+lines?\s+([0-9]+)(?:-([0-9]+))?$/i;
const ASSISTANT_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "env",
  "fish",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "proto",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
  // Documents, data, and media an agent produces and links to. Without these a
  // relative link to a report or a spreadsheet was plain text.
  "7z",
  "bmp",
  "csv",
  "db",
  "doc",
  "docx",
  "epub",
  "gif",
  "gz",
  "heic",
  "hwp",
  "hwpx",
  "ico",
  "ipynb",
  "jpeg",
  "jpg",
  "jsonl",
  "key",
  "log",
  "m4a",
  "mov",
  "mp3",
  "mp4",
  "ndjson",
  "numbers",
  "odp",
  "ods",
  "odt",
  "pages",
  "parquet",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "psd",
  "rtf",
  "sqlite",
  "svg",
  "tar",
  "tgz",
  "tsv",
  "wav",
  "webm",
  "webp",
  "xls",
  "xlsm",
  "xlsx",
  "zip",
  // Builds, installers, fonts, media, and exchange formats agents hand over by name
  // (`Daseo-0.5.101.apk`). Daseo delta 90.
  "aab",
  "aac",
  "apk",
  "avi",
  "avif",
  "bz2",
  "diff",
  "dmg",
  "eps",
  "exe",
  "fig",
  "flac",
  "ics",
  "ipa",
  "iso",
  "jar",
  "m4v",
  "mkv",
  "msi",
  "ogg",
  "opus",
  "otf",
  "patch",
  "pkg",
  "plist",
  "rar",
  "sketch",
  "srt",
  "tif",
  "tiff",
  "ttf",
  "vcf",
  "vtt",
  "whl",
  "woff",
  "woff2",
  "xz",
  "zst",
]);
// A token that already names a directory (`docs/x.foo`) is a path, not prose,
// so any short alphanumeric extension qualifies there.
const GENERIC_FILE_EXTENSION = /^[a-z0-9]{1,8}$/;
// Inline code marks its own boundaries, so a path there may contain spaces
// (`docs/최종 보고서.md`). Shell operators, flags, or a leading command word
// mean the token is a command line, not a path.
const SHELL_METACHARACTERS = /[|&;<>$*?"'`\n\t]/;
const EXPLICIT_PATH_PREFIX = /^(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/;

export interface AssistantHrefParseOptions {
  workspaceRoot?: string;
  /** Accept spaces inside the token when it still reads as one path. */
  allowWhitespace?: boolean;
  /**
   * The token is a markdown destination the agent wrote. markdown-it percent-encodes spaces and
   * non-ASCII in destinations, so the path is decoded; and an authored destination names a file
   * or folder, so it skips the filename guessing inferred text needs (upstream #7210, #7233).
   */
  explicitLink?: boolean;
}

export type AssistantFileLinkClassification =
  | {
      kind: "external";
      raw: string;
    }
  | {
      kind: "directFile";
      target: InlinePathTarget;
    }
  | {
      kind: "ambiguousFileCandidate";
      target: InlinePathTarget;
    }
  | {
      /**
       * A path shortened with `…` or `...` (`…/research/report.md`). It never names a file by
       * itself: the daemon searches below `head` (or the workspace) for the one entry ending
       * with `suffix`. Daseo delta 90.
       */
      kind: "elidedPath";
      target: InlinePathTarget;
      head: string;
      suffix: string;
    };

export interface NormalizedInlinePathTarget {
  directory: string;
  file?: string;
}

function normalizePathToken(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");

  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/");
}

function parseLineFragment(value: string): Pick<InlinePathTarget, "lineStart" | "lineEnd"> | null {
  const rawFragment = value.startsWith("#") ? value.slice(1) : value;
  if (!rawFragment) {
    return { lineStart: undefined, lineEnd: undefined };
  }

  const lineMatch = rawFragment.match(INLINE_LINE_FRAGMENT);
  const lineStart = lineMatch?.[1] ? parseInt(lineMatch[1], 10) : undefined;
  const lineEnd = lineMatch?.[2] ? parseInt(lineMatch[2], 10) : undefined;

  if (
    (lineStart !== undefined && (!Number.isFinite(lineStart) || lineStart <= 0)) ||
    (lineEnd !== undefined && (!Number.isFinite(lineEnd) || lineEnd <= 0)) ||
    (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)
  ) {
    return null;
  }

  return { lineStart, lineEnd };
}

/**
 * Strict VSCode-style markers only.
 *
 * Supported:
 * - `filename:linenumber`
 * - `filename:linenumber:columnnumber` as a line target
 * - `filename:lineStart-lineEnd`
 *
 * Not supported (by design):
 * - plain `filename` (no line)
 * - `:linenumber` (range-only)
 */
export function parseInlinePathToken(value: string): InlinePathTarget | null {
  const rawValue = value ?? "";
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const match =
    trimmed.match(INLINE_COLON_LINE_SUFFIX) ??
    trimmed.match(INLINE_PAREN_LINE_SUFFIX) ??
    trimmed.match(INLINE_WORD_LINE_SUFFIX);
  if (!match) {
    return null;
  }

  const basePathRaw = match[1]?.trim();
  if (!basePathRaw) {
    return null;
  }

  // Avoid accidentally treating URLs as file paths.
  if (basePathRaw.includes("://")) {
    return null;
  }

  const normalizedPath = normalizePathToken(basePathRaw);
  if (!normalizedPath) {
    return null;
  }

  const lineStart = parseInt(match[2], 10);
  if (!Number.isFinite(lineStart) || lineStart <= 0) {
    return null;
  }

  const lineEnd = match[3] ? parseInt(match[3], 10) : undefined;
  if (lineEnd !== undefined) {
    if (!Number.isFinite(lineEnd) || lineEnd <= 0) {
      return null;
    }
    if (lineEnd < lineStart) {
      return null;
    }
  }

  return {
    raw: rawValue,
    path: normalizedPath,
    lineStart,
    lineEnd,
  };
}

export function parseFileProtocolUrl(value: string): InlinePathTarget | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== FILE_PROTOCOL) {
    return null;
  }

  const normalizedPath = normalizeFileUrlPath(parsedUrl.pathname);
  if (!normalizedPath) {
    return null;
  }

  const lines = parseLineFragment(parsedUrl.hash);
  if (!lines) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...lines,
  };
}

function parseAssistantInlinePathLink(value: string): InlinePathTarget | null {
  const inlinePathTarget = parseInlinePathToken(value);
  if (!inlinePathTarget) {
    return null;
  }

  const normalizedPath = normalizePathToken(inlinePathTarget.path);
  if (!normalizedPath || !isAbsolutePath(normalizedPath)) {
    return null;
  }

  return {
    ...inlinePathTarget,
    path: normalizedPath,
  };
}

export function classifyAssistantFileLink(
  value: string,
  options: AssistantHrefParseOptions = {},
): AssistantFileLinkClassification | null {
  const raw = value ?? "";
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    return null;
  }

  if (isExternalHref(rawTrimmed)) {
    return {
      kind: "external",
      raw,
    };
  }

  if (/\s/.test(rawTrimmed) && !(options.allowWhitespace && isWhitespacePathToken(rawTrimmed))) {
    return null;
  }
  // A destination's spaces arrive percent-encoded; decoded, they are part of the path.
  const trimmed = options.explicitLink ? safeDecodeURIComponent(rawTrimmed) : rawTrimmed;

  if (ELLIPSIS_SEGMENT.test(trimmed)) {
    return parseElidedPath(trimmed, raw);
  }

  const webUrl = schemeLessWebUrl(trimmed);
  if (webUrl) {
    return { kind: "external", raw: webUrl };
  }

  const target = parseAssistantFileLink(trimmed, options);
  if (!target) {
    return null;
  }

  if (
    !options.explicitLink &&
    isAmbiguousWorkspaceCandidate(trimmed, target, options.workspaceRoot)
  ) {
    return {
      kind: "ambiguousFileCandidate",
      target,
    };
  }

  return {
    kind: "directFile",
    target,
  };
}

export function parseAssistantFileLink(
  value: string,
  options: AssistantHrefParseOptions = {},
): InlinePathTarget | null {
  const fileUrlTarget = parseFileProtocolUrl(value);
  if (fileUrlTarget) {
    return fileUrlTarget;
  }

  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (isExternalHref(trimmed)) {
    return null;
  }

  const inlinePathTarget = parseAssistantInlinePathLink(trimmed);
  if (inlinePathTarget) {
    return inlinePathTarget;
  }

  const windowsPathMatch = trimmed.match(/^([A-Za-z]:[\\/][^?#]*)(#[^?]+)?$/);
  if (windowsPathMatch) {
    const normalizedPath = normalizePathToken(windowsPathMatch[1] ?? "");
    if (!normalizedPath) {
      return null;
    }

    const lines = parseLineFragment(windowsPathMatch[2] ?? "");
    if (!lines) {
      return null;
    }

    return {
      raw: value,
      path: normalizedPath,
      ...lines,
    };
  }

  const relativeTarget = parseWorkspaceRelativeFileLink(trimmed, {
    workspaceRoot: options.workspaceRoot,
    explicitLink: options.explicitLink,
  });
  if (relativeTarget) {
    return relativeTarget;
  }

  if (!isAbsolutePath(trimmed)) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed, "http://paseo.invalid");
  } catch {
    return null;
  }

  const normalizedPath = normalizePathToken(safeDecodeURIComponent(parsedUrl.pathname));
  if (!normalizedPath || !isAbsolutePath(normalizedPath)) {
    return null;
  }

  const lines = parseLineFragment(parsedUrl.hash);
  if (!lines) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...lines,
  };
}

export function isFileLookingAssistantToken(value: string): boolean {
  const normalized = normalizePathToken(value);
  if (
    !normalized ||
    /\s/.test(normalized) ||
    normalized.includes("?") ||
    normalized.includes("://")
  ) {
    return false;
  }

  const path = getHeuristicLocalPath(normalized);
  if (!path) {
    return false;
  }

  return isPlausibleAssistantLocalPath(path);
}

function parseWorkspaceRelativeFileLink(
  value: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const parsed = parseLocalPathParts(value, options);
  if (!parsed || isAbsolutePath(parsed.path)) {
    return null;
  }

  if (isHomeRelativePath(parsed.path)) {
    return {
      raw: value,
      path: parsed.path,
      ...parsed.lines,
    };
  }

  const workspaceRoot = normalizePathInput(options.workspaceRoot);
  if (!workspaceRoot) {
    return null;
  }

  const normalizedPath = resolveRelativePathUnderRoot(parsed.path, workspaceRoot);
  if (!normalizedPath) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...parsed.lines,
  };
}

function parseLocalPathParts(
  value: string,
  options: Pick<AssistantHrefParseOptions, "explicitLink"> = {},
): { path: string; lines: Pick<InlinePathTarget, "lineStart" | "lineEnd"> } | null {
  const normalized = normalizePathToken(value);
  if (!normalized || normalized.includes("?")) {
    return null;
  }

  const hashIndex = normalized.indexOf("#");
  const beforeHash = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
  const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : "";
  const fragmentLines = parseLineFragment(hash);
  if (!fragmentLines) {
    return null;
  }

  const inlinePathTarget = parseInlinePathToken(beforeHash);
  if (inlinePathTarget) {
    if (!isAcceptedLocalPath(inlinePathTarget.path, options)) {
      return null;
    }

    return {
      path: inlinePathTarget.path,
      lines: {
        lineStart: inlinePathTarget.lineStart,
        lineEnd: inlinePathTarget.lineEnd,
      },
    };
  }

  if (!beforeHash || beforeHash.includes(":")) {
    return null;
  }

  if (!isAcceptedLocalPath(beforeHash, options)) {
    return null;
  }

  return {
    path: beforeHash,
    lines: fragmentLines,
  };
}

/**
 * An authored destination is taken as written (a web address was already turned into an https
 * link before this); inferred text must look like a file.
 */
function isAcceptedLocalPath(
  pathValue: string,
  options: Pick<AssistantHrefParseOptions, "explicitLink">,
): boolean {
  return options.explicitLink
    ? pathValue.split("/").some(Boolean)
    : isPlausibleAssistantLocalPath(pathValue);
}

export function normalizeInlinePathTarget(
  rawPath: string,
  cwd?: string,
): NormalizedInlinePathTarget | null {
  if (!rawPath) {
    return null;
  }

  const normalizedInput = normalizePathInput(rawPath);
  if (!normalizedInput) {
    return null;
  }

  let normalized = normalizedInput;
  const cwdRelative = resolvePathAgainstCwd(normalized, cwd);
  if (cwdRelative) {
    normalized = cwdRelative;
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2) || ".";
  }

  if (!normalized.length) {
    normalized = ".";
  }

  if (normalized === ".") {
    return { directory: "." };
  }

  if (normalized.endsWith("/")) {
    const dir = normalized.replace(/\/+$/, "");
    return { directory: dir.length > 0 ? dir : "." };
  }

  const lastSlash = normalized.lastIndexOf("/");
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";

  return {
    directory: directory.length > 0 ? directory : ".",
    file: normalized,
  };
}

function isAllowedAbsolutePath(pathValue: string, workspaceRoot?: string): boolean {
  const normalizedWorkspaceRoot = normalizePathInput(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return true;
  }

  const comparePath = normalizePathForCompare(pathValue);
  const compareWorkspaceRoot = normalizePathForCompare(
    normalizedWorkspaceRoot.replace(/\/+$/, "") || "/",
  );
  const comparePrefix = compareWorkspaceRoot === "/" ? "/" : `${compareWorkspaceRoot}/`;

  return comparePath === compareWorkspaceRoot || comparePath.startsWith(comparePrefix);
}

function isHomeRelativePath(pathValue: string): boolean {
  return pathValue === "~" || pathValue.startsWith("~/") || pathValue.startsWith("~\\");
}

function isExternalHref(value: string): boolean {
  if (value.includes("://")) {
    return !value.toLowerCase().startsWith(`${FILE_PROTOCOL}//`);
  }

  const inlinePathTarget = parseInlinePathToken(value);
  if (inlinePathTarget) {
    return false;
  }

  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function isAmbiguousWorkspaceCandidate(
  value: string,
  target: InlinePathTarget,
  workspaceRoot?: string,
): boolean {
  const normalizedWorkspaceRoot = normalizePathInput(workspaceRoot);
  if (!normalizedWorkspaceRoot || !isAllowedAbsolutePath(target.path, normalizedWorkspaceRoot)) {
    return false;
  }

  const parsed = parseLocalPathParts(value);
  if (!parsed || isAbsolutePath(parsed.path)) {
    return false;
  }

  return !parsed.path.includes("/");
}

function getHeuristicLocalPath(value: string): string | null {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  if (!parseLineFragment(hash)) {
    return null;
  }

  const inlinePathTarget = parseInlinePathToken(beforeHash);
  if (inlinePathTarget) {
    return inlinePathTarget.path;
  }

  if (!beforeHash || beforeHash.includes(":")) {
    return null;
  }

  return beforeHash;
}

function isPlausibleAssistantLocalPath(pathValue: string): boolean {
  const normalized = normalizePathToken(pathValue);
  if (!normalized) {
    return false;
  }

  if (isAbsolutePath(normalized)) {
    return true;
  }

  const explicitRelative =
    normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("~/");
  if (explicitRelative) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) {
    return false;
  }

  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    return (
      !isDomainLikePathSegment(firstSegment) &&
      isPlausibleAssistantFileName(lastSegment, { inDirectory: true })
    );
  }

  return isPlausibleAssistantFileName(firstSegment, { inDirectory: false });
}

function isPlausibleAssistantFileName(
  fileName: string | undefined,
  options: { inDirectory: boolean },
): boolean {
  if (!fileName) {
    return false;
  }

  if (fileName.startsWith(".") && fileName.length > 1) {
    return true;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return false;
  }

  const extension = fileName.slice(lastDot + 1).toLowerCase();
  if (ASSISTANT_FILE_EXTENSIONS.has(extension)) {
    return true;
  }
  return options.inDirectory && GENERIC_FILE_EXTENSION.test(extension);
}

export function isWhitespacePathToken(token: string): boolean {
  if (SHELL_METACHARACTERS.test(token) || /(?:^|\s)-/.test(token)) {
    return false;
  }
  if (EXPLICIT_PATH_PREFIX.test(token)) {
    return true;
  }
  const firstWord = token.split(/\s+/)[0] ?? "";
  if (firstWord.includes("/")) {
    return isPlausibleAssistantLocalPath(token);
  }
  // A bare name with spaces (`회사 자료 접근 지도.md`) is a file when it ends in a known
  // extension and does not start with a command (`open report.pdf`). Daseo delta 90.
  if (token.includes("/") || COMMAND_WORDS.has(firstWord.toLowerCase())) {
    return false;
  }
  const lastDot = token.lastIndexOf(".");
  return lastDot > 0 && ASSISTANT_FILE_EXTENSIONS.has(token.slice(lastDot + 1).toLowerCase());
}

const COMMAND_WORDS = new Set([
  "adb",
  "awk",
  "bash",
  "brew",
  "bun",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "code",
  "cp",
  "curl",
  "cursor",
  "deno",
  "docker",
  "echo",
  "ffmpeg",
  "find",
  "git",
  "go",
  "grep",
  "head",
  "java",
  "less",
  "ls",
  "make",
  "mkdir",
  "more",
  "mv",
  "nano",
  "node",
  "npm",
  "npx",
  "open",
  "perl",
  "pip",
  "pip3",
  "pnpm",
  "python",
  "python3",
  "rg",
  "rm",
  "rsync",
  "ruby",
  "scp",
  "sed",
  "sh",
  "sips",
  "source",
  "ssh",
  "subl",
  "sudo",
  "tail",
  "tar",
  "touch",
  "tsx",
  "unzip",
  "uv",
  "vi",
  "vim",
  "wget",
  "yarn",
  "zip",
  "zsh",
]);

// A path segment that is only an ellipsis: `…/a.md`, `src/.../a.ts`, `~/ws/…`.
const ELLIPSIS_SEGMENT = /(?:^|\/)(?:…|\.{3})(?=\/|$)/;
const ELLIPSIS_SEGMENT_GLOBAL = /(?:^|\/)(?:…|\.{3})(?=\/|$)/g;
// Globs and brace lists name several files at once; none of them is one link.
const PATTERN_CHARACTERS = /[*?{}[\]]/;

/**
 * `…/research/report.md:12` → head `""`, suffix `research/report.md`, line 12. The head is what
 * the agent kept before the first ellipsis (`~`, an absolute path, or a relative directory),
 * the suffix what follows the last one. A suffix must end in a file name or a folder slash.
 */
function parseElidedPath(
  value: string,
  raw: string,
): Extract<AssistantFileLinkClassification, { kind: "elidedPath" }> | null {
  const located = splitLineReference(value);
  if (!located || PATTERN_CHARACTERS.test(located.path) || located.path.includes("://")) {
    return null;
  }
  const parts = splitAtEllipses(located.path);
  if (!parts || !isElidedSuffix(parts.suffix)) {
    return null;
  }
  const headFirstSegment = parts.head.split("/").find(Boolean);
  if (headFirstSegment && isDomainLikePathSegment(headFirstSegment)) {
    return null;
  }
  return {
    kind: "elidedPath",
    head: parts.head,
    suffix: parts.suffix.split("/").filter(Boolean).join("/"),
    target: { raw, path: located.path, ...located.lines },
  };
}

/** `a/b.md:12` or `a/b.md#L12` → the path and its line range. */
function splitLineReference(
  value: string,
): { path: string; lines: Pick<InlinePathTarget, "lineStart" | "lineEnd"> } | null {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const fragmentLines = parseLineFragment(hashIndex >= 0 ? value.slice(hashIndex) : "");
  if (!fragmentLines) {
    return null;
  }
  const withLines = parseInlinePathToken(beforeHash);
  const path = normalizePathToken(withLines?.path ?? beforeHash);
  if (!path) {
    return null;
  }
  const lines = withLines
    ? { lineStart: withLines.lineStart, lineEnd: withLines.lineEnd }
    : fragmentLines;
  return { path, lines };
}

/** What the agent kept before the first ellipsis, and what follows the last one. */
function splitAtEllipses(pathPart: string): { head: string; suffix: string } | null {
  const ellipses = [...pathPart.matchAll(ELLIPSIS_SEGMENT_GLOBAL)];
  const first = ellipses[0];
  const last = ellipses.at(-1);
  if (first?.index === undefined || last?.index === undefined) {
    return null;
  }
  return {
    head: pathPart.slice(0, first.index).replace(/\/+$/, ""),
    suffix: pathPart.slice(last.index + last[0].length).replace(/^\/+/, ""),
  };
}

/** A suffix ends in a file name or a folder slash, and never climbs with `..`. */
function isElidedSuffix(suffix: string): boolean {
  const segments = suffix.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment || segments.includes("..")) {
    return false;
  }
  return suffix.endsWith("/") || isPlausibleAssistantFileName(lastSegment, { inDirectory: true });
}

// Generic TLDs, plus any two-letter country code. A host without a path also needs a third
// label or one of the TLDs an agent means as a website (`naver.com`, not `Daseo.app`).
const GENERIC_TLDS = new Set([
  "app",
  "art",
  "asia",
  "biz",
  "blog",
  "cloud",
  "com",
  "design",
  "dev",
  "edu",
  "gov",
  "info",
  "io",
  "link",
  "live",
  "me",
  "name",
  "net",
  "news",
  "online",
  "org",
  "page",
  "pro",
  "shop",
  "site",
  "store",
  "studio",
  "tech",
  "wiki",
  "xyz",
]);
const HOST_ONLY_TLDS = new Set(["com", "net", "org", "io", "dev", "co", "kr", "jp", "me", "xyz"]);
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * `invite.folnua.com/seoulforest/` → `https://invite.folnua.com/seoulforest/`. A file name is
 * never a host (`file.html`, `index.ts`, `app.module.ts`), and neither is a version
 * (`0.5.101`). Daseo delta 90: the Tailscale and company sites agents name serve https only.
 */
export function schemeLessWebUrl(token: string): string | null {
  if (/\s/.test(token) || token.includes("://") || ELLIPSIS_SEGMENT.test(token)) {
    return null;
  }
  const hostEnd = token.search(/[/?#]/);
  const host = hostEnd >= 0 ? token.slice(0, hostEnd) : token;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) {
    return null;
  }
  const tld = (labels.at(-1) ?? "").toLowerCase();
  if (!/^[a-z]{2,}$/.test(tld) || !(GENERIC_TLDS.has(tld) || tld.length === 2)) {
    return null;
  }
  const hasPath = hostEnd >= 0 && token.length > hostEnd + 1;
  if (!hasPath) {
    if (ASSISTANT_FILE_EXTENSIONS.has(tld)) {
      return null;
    }
    if (labels.length < 3 && !HOST_ONLY_TLDS.has(tld)) {
      return null;
    }
  }
  return `https://${token}`;
}

function isDomainLikePathSegment(segment: string): boolean {
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(segment);
}

function resolveRelativePathUnderRoot(pathValue: string, workspaceRoot: string): string | null {
  const normalizedPath = normalizePathToken(pathValue);
  if (!normalizedPath || isAbsolutePath(normalizedPath)) {
    return null;
  }

  const root = workspaceRoot.replace(/\/+$/, "") || "/";
  const pathSegments = normalizedPath.split("/");
  const resolvedSegments: string[] = [];
  for (const segment of pathSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolvedSegments.length === 0) {
        return null;
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }

  if (resolvedSegments.length === 0) {
    return root;
  }

  return root === "/" ? `/${resolvedSegments.join("/")}` : `${root}/${resolvedSegments.join("/")}`;
}

function normalizeFileUrlPath(pathname: string): string | null {
  if (!pathname) {
    return null;
  }

  const decoded = safeDecodeURIComponent(pathname).replace(/\\/g, "/");
  if (!decoded) {
    return null;
  }

  if (/^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1);
  }

  return decoded;
}

function normalizePathInput(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function resolvePathAgainstCwd(pathValue: string, cwd?: string): string | null {
  const normalizedCwd = normalizePathInput(cwd);
  if (!normalizedCwd || !isAbsolutePath(pathValue) || !isAbsolutePath(normalizedCwd)) {
    return null;
  }

  const normalizedCwdBase = normalizedCwd.replace(/\/+$/, "") || "/";
  const comparePath = normalizePathForCompare(pathValue);
  const compareCwd = normalizePathForCompare(normalizedCwdBase);
  const prefix = normalizedCwdBase === "/" ? "/" : `${normalizedCwdBase}/`;
  const comparePrefix = normalizePathForCompare(prefix);

  if (comparePath === compareCwd) {
    return ".";
  }

  if (comparePath.startsWith(comparePrefix)) {
    return pathValue.slice(prefix.length) || ".";
  }

  return null;
}

function normalizePathForCompare(value: string): string {
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}
