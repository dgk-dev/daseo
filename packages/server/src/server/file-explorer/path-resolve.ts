import { promises as fs, type Dirent } from "fs";
import path from "path";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";
import { resolveReadableExplorerPath } from "./service.js";

export type NamedPathKind = "file" | "directory";

export interface NamedPathMatch {
  path: string;
  kind: NamedPathKind;
}

export interface ResolveNamedPathInput {
  /** Workspace root; relative candidates and search roots resolve here. */
  cwd: string;
  /** Exact paths the name may mean, absolute, `~/`, or relative to `cwd`. */
  candidates: string[];
  /** When no candidate exists, find entries whose path ends with `/<suffix>`. */
  suffix?: string;
  /** Segments a suffix match must also contain, contiguous, before the suffix. */
  contains?: string;
  /** Where the suffix search walks; defaults to `cwd`. */
  searchRoots?: string[];
  /** Directories never walked (the daemon's own timeline store holds millions of files). */
  skipPaths?: string[];
  budgetMs?: number;
  now?: () => number;
}

export interface ResolveNamedPathResult {
  /** Existing candidates, or up to two suffix matches; two means the name is ambiguous. */
  matches: NamedPathMatch[];
  /** False when the search stopped at its time budget before covering every root. */
  complete: boolean;
}

const MAX_CANDIDATES = 16;
const MAX_SEARCH_ROOTS = 4;
const MAX_SEARCH_DEPTH = 14;
const SUFFIX_MATCH_LIMIT = 2;
export const DEFAULT_NAMED_PATH_BUDGET_MS = 3_000;

// Package stores, build caches, VCS internals, and system folders: nothing an agent writes for
// the owner lives there, and together they hold most of the entries in a home directory.
// Other hidden folders (`~/.pi`, `.dev`, `.secrets`) stay searchable, because agent plans and
// reports live there and the explorer's suffix search skips them.
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "Library",
  ".Trash",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  ".cargo",
  ".rustup",
  ".cocoapods",
  ".android",
  ".docker",
  ".local",
  ".bun",
  ".nvm",
  ".pyenv",
  ".deno",
  "Pods",
  "DerivedData",
  ".next",
  ".turbo",
  ".expo",
  "__pycache__",
  ".venv",
  "venv",
  ".Spotlight-V100",
  ".fseventsd",
]);

/**
 * Resolve a path an agent named in an answer to entries that exist. Exact candidates win; a
 * suffix search runs only when none exists, walks without following symlinks, and stops after
 * two matches so the caller can tell a unique match from an ambiguous one. Every candidate,
 * root, and match is confined to the explorer's readable roots (workspace, home, temp).
 */
export async function resolveNamedPath(
  input: ResolveNamedPathInput,
): Promise<ResolveNamedPathResult> {
  const cwd = expandUserPath(input.cwd);
  const exact: NamedPathMatch[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates.slice(0, MAX_CANDIDATES)) {
    const match = await statReadable(cwd, resolvePathFromBase(cwd, candidate));
    if (match && !seen.has(match.path)) {
      seen.add(match.path);
      exact.push(match);
    }
  }
  if (exact.length > 0) {
    return { matches: exact, complete: true };
  }

  const suffix = normalizeSegments(input.suffix);
  if (suffix.length === 0) {
    return { matches: [], complete: true };
  }
  const contains = normalizeSegments(input.contains);
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? DEFAULT_NAMED_PATH_BUDGET_MS);
  const skipPaths = new Set((input.skipPaths ?? []).map((value) => expandUserPath(value)));
  const roots = (input.searchRoots && input.searchRoots.length > 0 ? input.searchRoots : [cwd])
    .slice(0, MAX_SEARCH_ROOTS)
    .map((root) => resolvePathFromBase(cwd, root));

  const matches: NamedPathMatch[] = [];
  const visitedRoots: string[] = [];
  for (const root of roots) {
    if (visitedRoots.some((visited) => isWithin(visited, root))) {
      continue;
    }
    visitedRoots.push(root);
    const outcome = await searchSuffix({
      cwd,
      root,
      suffix,
      contains,
      skipPaths,
      deadline,
      now,
      matches,
      seen,
    });
    if (outcome === "limit") {
      return { matches, complete: true };
    }
    if (outcome === "deadline") {
      return { matches, complete: false };
    }
  }
  return { matches, complete: true };
}

interface SuffixSearch {
  cwd: string;
  root: string;
  suffix: string[];
  contains: string[];
  skipPaths: Set<string>;
  deadline: number;
  now: () => number;
  matches: NamedPathMatch[];
  seen: Set<string>;
}

async function searchSuffix(input: SuffixSearch): Promise<"done" | "limit" | "deadline"> {
  // Breadth-first, so a shallow match is found before a deep one.
  let level: string[] = [input.root];
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (input.now() > input.deadline) {
        return "deadline";
      }
      const outcome = await visitDirectory(input, directory, next);
      if (outcome === "limit") {
        return "limit";
      }
    }
    level = next;
  }
  return "done";
}

/** Checks one directory for the suffix and queues its walkable subdirectories. */
async function visitDirectory(
  input: SuffixSearch,
  directory: string,
  next: string[],
): Promise<"continue" | "limit"> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return "continue";
  }
  for (const entry of entries) {
    if (entry.name === input.suffix[0] && (await recordSuffixMatch(input, directory))) {
      return "limit";
    }
    const child = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !SKIPPED_DIRECTORY_NAMES.has(entry.name) &&
      !input.skipPaths.has(child)
    ) {
      next.push(child);
    }
  }
  return "continue";
}

/** True once the search holds enough matches to call the name ambiguous. */
async function recordSuffixMatch(input: SuffixSearch, directory: string): Promise<boolean> {
  const candidate = path.join(directory, ...input.suffix);
  if (
    input.seen.has(candidate) ||
    !containsSegments(path.relative(input.root, directory), input.contains)
  ) {
    return false;
  }
  const match = await statReadable(input.cwd, candidate);
  if (!match || input.seen.has(match.path)) {
    return false;
  }
  input.seen.add(match.path);
  input.matches.push(match);
  return input.matches.length >= SUFFIX_MATCH_LIMIT;
}

async function statReadable(cwd: string, absolutePath: string): Promise<NamedPathMatch | null> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolveReadableExplorerPath({ root: cwd, targetPath: absolutePath });
  } catch {
    return null;
  }
  try {
    const stats = await fs.stat(resolvedPath);
    if (stats.isDirectory()) {
      return { path: absolutePath, kind: "directory" };
    }
    return stats.isFile() ? { path: absolutePath, kind: "file" } : null;
  } catch {
    return null;
  }
}

function normalizeSegments(value: string | undefined): string[] {
  const segments = (value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  // A suffix names a place below a directory; `..` would walk out of it.
  return segments.includes("..") ? [] : segments;
}

function containsSegments(relativeDirectory: string, contains: string[]): boolean {
  if (contains.length === 0) {
    return true;
  }
  const segments = relativeDirectory.split(path.sep).filter(Boolean);
  for (let start = 0; start + contains.length <= segments.length; start += 1) {
    if (contains.every((segment, offset) => segments[start + offset] === segment)) {
      return true;
    }
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
