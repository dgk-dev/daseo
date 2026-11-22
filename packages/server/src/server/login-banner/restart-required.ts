import path from "node:path";

/**
 * Daseo delta 144: is a newer Daseo build on disk than the daemon that is running?
 *
 * A Mac release stages the signed bundle at `~/Applications/Paseo Local Patch.app`, then an
 * idle-gated script copies it over `/Applications/Daseo.app` and restarts the app and the daemon
 * (DASEO.md, Build & ship). So, while a replacement waits, the staged bundle is newer than the
 * running daemon; and when the app was replaced but the daemon survived the swap, the daemon's own
 * bundle is. After a completed activation all three versions match. Neither check alone covers
 * both cases, and neither is true outside them. A daemon that is not running from an app bundle
 * (a checkout's dev daemon, Linux, Docker) has nothing to restart into and reports nothing.
 */
export const STAGED_BUNDLE_RELATIVE_PATH = "Applications/Paseo Local Patch.app";
const INFO_PLIST = "Contents/Info.plist";

/** The outermost `.app` directory that contains `execPath`, or null outside an app bundle. */
export function resolveOwnAppBundle(execPath: string): string | null {
  const match = /^(.*?\.app)\//.exec(execPath);
  return match?.[1] ?? null;
}

export function infoPlistPaths(input: { ownBundle: string; homeDir: string }): string[] {
  return [
    path.join(input.ownBundle, INFO_PLIST),
    path.join(input.homeDir, STAGED_BUNDLE_RELATIVE_PATH, INFO_PLIST),
  ];
}

/** `CFBundleShortVersionString` from an XML `Info.plist`. */
export function parseBundleShortVersion(plist: string): string | null {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  const version = match?.[1]?.trim();
  return version && parseVersion(version) ? version : null;
}

/** The newest of `installed` that is newer than `running`, or null. */
export function newerInstalledVersion(
  running: string,
  installed: readonly string[],
): string | null {
  const runningParts = parseVersion(running);
  if (!runningParts) return null;
  let newest: { version: string; parts: number[] } | null = null;
  for (const version of installed) {
    const parts = parseVersion(version);
    if (!parts || compareVersions(parts, runningParts) <= 0) continue;
    if (!newest || compareVersions(parts, newest.parts) > 0) newest = { version, parts };
  }
  return newest?.version ?? null;
}

/** `0.5.151` or `0.5.151-beta.1` (the suffix is ignored); anything else is not a version. */
function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
