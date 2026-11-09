import {
  classifyAssistantFileLink,
  isFileLookingAssistantToken,
  type AssistantFileLinkClassification,
  type InlinePathTarget,
} from "./parse";
import { i18n } from "@/i18n/i18next";

export interface AssistantFileLinkSource {
  href: string;
  text?: string;
  title?: string;
  markup?: string;
  sourceInfo?: string;
  sourceType?: "inline-code";
}

export interface AssistantFileLinkContext {
  workspaceRoot?: string;
}

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

export interface DirectorySuggestionResult {
  entries: DirectorySuggestionEntry[];
  error: string | null;
}

export type GetDirectorySuggestions = (input: {
  query: string;
  cwd: string;
  includeFiles: true;
  includeDirectories: false;
  matchMode: "suffix";
  limit: number;
}) => Promise<DirectorySuggestionResult>;

export type ResolvedAssistantFileLink =
  | { kind: "external"; url: string }
  | { kind: "file"; target: InlinePathTarget }
  | { kind: "ignored" };

export type AssistantFileLinkResolution =
  | { kind: "resolved"; value: ResolvedAssistantFileLink }
  | {
      kind: "needsLookup";
      ambiguousQuery: string;
      token: string;
      target: InlinePathTarget;
    };

/** Daseo delta 90: with a daemon that resolves paths, it finds what a link names first. */
export type AssistantFileLinkPlan =
  | AssistantFileLinkResolution
  | {
      kind: "needsPathResolve";
      token: string;
      target: InlinePathTarget;
      query: PathResolveQuery;
    };

/** What the daemon is asked: exact paths first, then a suffix search. */
export interface PathResolveQuery {
  candidates: string[];
  suffix?: string;
  contains?: string;
  searchRoots?: string[];
}

export interface PathResolveMatch {
  path: string;
  kind: "file" | "directory";
}

export type ResolvePath = (
  input: PathResolveQuery & { cwd: string },
) => Promise<{ matches: PathResolveMatch[]; complete: boolean; error: string | null }>;

export type PathResolveOutcome =
  | { kind: "found"; target: InlinePathTarget; isDirectory: boolean }
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "incomplete" };

export interface FetchDaemonResolutionInput {
  ambiguousQuery: string;
  token: string;
  target: InlinePathTarget;
  workspaceRoot?: string;
  getDirectorySuggestions: GetDirectorySuggestions;
}

export class UnresolvedFileLinkError extends Error {
  constructor(readonly token: string) {
    super(i18n.t("common.errors.noFileFound", { token }));
    this.name = "UnresolvedFileLinkError";
  }
}

export async function fetchDaemonResolution({
  ambiguousQuery,
  token,
  target,
  workspaceRoot,
  getDirectorySuggestions,
}: FetchDaemonResolutionInput): Promise<InlinePathTarget> {
  const trimmedRoot = workspaceRoot?.trim();
  if (!trimmedRoot) {
    throw new UnresolvedFileLinkError(token);
  }

  let suggestions: DirectorySuggestionResult;
  try {
    suggestions = await getDirectorySuggestions({
      query: ambiguousQuery,
      cwd: trimmedRoot,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      limit: 1,
    });
  } catch {
    throw new UnresolvedFileLinkError(token);
  }

  const match = suggestions.entries.find((entry) => entry.kind === "file");
  if (!match || suggestions.error) {
    // The suffix search skips gitignored and hidden entries, so a real file in
    // `tmp/` or `.secrets/` never matches. A token that names its directory
    // already identifies the file: open it directly and let the file pane
    // report a genuinely missing one. A bare basename has nothing to fall
    // back to.
    if (ambiguousQuery.includes("/")) {
      return target;
    }
    throw new UnresolvedFileLinkError(token);
  }

  return {
    ...target,
    path: joinWorkspacePath(trimmedRoot, match.path),
  };
}

function classifySource(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): { token: string; classification: AssistantFileLinkClassification } | null {
  const token = getAssistantFileLinkToken(source).trim();
  if (!token) {
    return null;
  }
  const explicitLink =
    token === source.href.trim() &&
    source.sourceType !== "inline-code" &&
    !isLinkifiedSource(source);
  const classification = classifyAssistantFileLink(token, {
    workspaceRoot: context.workspaceRoot,
    allowWhitespace: source.sourceType === "inline-code",
    explicitLink,
  });
  return classification ? { token, classification } : null;
}

export function planAssistantFileLink(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext & { pathResolve?: boolean },
): AssistantFileLinkPlan {
  const workspaceRoot = context.workspaceRoot?.trim();
  const classified = context.pathResolve && workspaceRoot ? classifySource(source, context) : null;
  if (!classified || !workspaceRoot || classified.classification.kind === "external") {
    return classifyForResolution(source, context);
  }
  const { token, classification } = classified;
  return {
    kind: "needsPathResolve",
    token,
    target: classification.target,
    query: buildPathResolveQuery({ classification, token, workspaceRoot }),
  };
}

export function classifyForResolution(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): AssistantFileLinkResolution {
  const classified = classifySource(source, context);
  if (!classified) {
    return { kind: "resolved", value: { kind: "ignored" } };
  }
  const { token, classification } = classified;
  if (classification.kind === "external") {
    return {
      kind: "resolved",
      value: { kind: "external", url: preferHttpsForBareHost(source, classification.raw) },
    };
  }
  if (classification.kind === "elidedPath") {
    // Only a daemon that can search may open a shortened path; nothing else guesses it.
    return { kind: "resolved", value: { kind: "ignored" } };
  }
  if (
    classification.kind === "directFile" &&
    !shouldResolveDirectFileThroughSuggestions({
      context,
      source,
      token,
      target: classification.target,
    })
  ) {
    return { kind: "resolved", value: { kind: "file", target: classification.target } };
  }

  const workspaceRoot = context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return { kind: "resolved", value: { kind: "ignored" } };
  }

  return {
    kind: "needsLookup",
    ambiguousQuery: getAmbiguousSuggestionQuery(classification.target, workspaceRoot),
    token,
    target: classification.target,
  };
}

/**
 * Daseo delta 90. Exact paths are tried first; a name that may sit deeper (a bare file name, a
 * workspace-relative path written against another base, upstream #8361, or a path shortened
 * with an ellipsis) also gets a suffix search, and only a single hit opens.
 */
export function buildPathResolveQuery(input: {
  classification: Exclude<AssistantFileLinkClassification, { kind: "external" }>;
  token: string;
  workspaceRoot: string;
}): PathResolveQuery {
  const { classification, workspaceRoot } = input;
  if (classification.kind === "elidedPath") {
    const { head, suffix } = classification;
    if (head === "~" || head.startsWith("~/") || isAbsolutePathToken(head)) {
      return { candidates: [], suffix, searchRoots: [head] };
    }
    const searchRoots = [workspaceRoot, "~"];
    return head
      ? { candidates: [], suffix, contains: head, searchRoots }
      : { candidates: [], suffix, searchRoots };
  }
  const path = classification.target.path;
  const relative = relativeToWorkspace(path, workspaceRoot);
  const writtenAsRelative =
    relative !== null &&
    !isAbsolutePathToken(input.token) &&
    !input.token.startsWith("~") &&
    !input.token.toLowerCase().startsWith("file:");
  if (!writtenAsRelative || relative === null || relative.length === 0) {
    return { candidates: [path] };
  }
  return { candidates: [path], suffix: relative, searchRoots: [workspaceRoot] };
}

/** One existing match opens; none, several, or an unfinished search never guesses. */
export async function resolvePathThroughDaemon(input: {
  query: PathResolveQuery;
  target: InlinePathTarget;
  workspaceRoot: string;
  resolvePath: ResolvePath;
}): Promise<PathResolveOutcome> {
  const result = await input.resolvePath({ ...input.query, cwd: input.workspaceRoot });
  if (result.error) {
    return { kind: "missing" };
  }
  const [match, second] = result.matches;
  if (second) {
    return { kind: "ambiguous" };
  }
  if (!match) {
    return result.complete ? { kind: "missing" } : { kind: "incomplete" };
  }
  if (!result.complete) {
    return { kind: "incomplete" };
  }
  return {
    kind: "found",
    isDirectory: match.kind === "directory",
    target: {
      raw: input.target.raw,
      path: match.path,
      lineStart: input.target.lineStart,
      lineEnd: input.target.lineEnd,
    },
  };
}

function relativeToWorkspace(targetPath: string, workspaceRoot: string): string | null {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = targetPath.replace(/\\/g, "/");
  if (normalized === root) {
    return "";
  }
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null;
}

function isAbsolutePathToken(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

// linkify writes `http://` in front of a bare host (`mac.tail29eaf5.ts.net`); the sites agents
// name serve https, and Tailscale serve answers only https. Daseo delta 90.
function preferHttpsForBareHost(source: AssistantFileLinkSource, url: string): string {
  const text = source.text?.trim() ?? "";
  if (
    isLinkifiedSource(source) &&
    url.toLowerCase().startsWith("http://") &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  ) {
    return `https://${url.slice("http://".length)}`;
  }
  return url;
}

export function getAssistantFileLinkToken(source: AssistantFileLinkSource): string {
  if (isLinkifiedSource(source) || source.sourceType === "inline-code") {
    const text = source.text?.trim();
    if (text && isFileLookingAssistantToken(text)) {
      return text;
    }
  }

  return source.href;
}

export function getAmbiguousSuggestionQuery(
  target: InlinePathTarget,
  workspaceRoot: string,
): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = target.path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lastSlash = normalizedPath.lastIndexOf("/");
  return lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
}

export function shouldResolveDirectFileThroughSuggestions(input: {
  context: AssistantFileLinkContext;
  source: AssistantFileLinkSource;
  token: string;
  target: InlinePathTarget;
}): boolean {
  if (input.source.sourceType !== "inline-code") {
    return false;
  }

  if (isAbsoluteInlineCodeToken(input.token)) {
    return false;
  }

  const workspaceRoot = input.context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return false;
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = input.target.path.replace(/\\/g, "/");
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isAbsoluteInlineCodeToken(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.toLowerCase().startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

function isLinkifiedSource(source: AssistantFileLinkSource): boolean {
  return source.markup === "linkify" || source.sourceInfo === "auto";
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return root ? `${root}/${child}` : child;
}

export type { AssistantFileLinkClassification };
