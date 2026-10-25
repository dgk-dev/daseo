const HOME_DIRECTORY_PREFIX = /^\/(?:Users|home)\/[^/]+/;

/**
 * Shortens a file path by replacing the home directory prefix with ~.
 * Handles both macOS (/Users/username) and Linux (/home/username) paths.
 */
export function shortenPath(path: string | undefined | null): string {
  if (!path) {
    return "";
  }
  return path.replace(HOME_DIRECTORY_PREFIX, "~");
}

/** True when the path is a home directory itself, the same rule `shortenPath` uses for `~`. */
export function isHomeDirectoryPath(path: string | undefined | null): boolean {
  if (!path) {
    return false;
  }
  return shortenPath(path.replace(/\/+$/, "")) === "~";
}
