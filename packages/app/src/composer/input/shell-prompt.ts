/**
 * Daseo delta 115: the composer and every sent prompt start with Ubuntu's default bash prompt,
 * `user@host:path$` (`/etc/skel/.bashrc`, `PS1='\u@\h:\w\$ '`). The daemon reports its hostname;
 * it does not report its OS user, so the user is the home folder the working directory sits
 * under, and the path shows that home as `~`, as bash's `\w` does.
 */
export interface ShellPromptParts {
  /** `\u`, or null when the directory is not under a recognisable home folder. */
  user: string | null;
  /** `\h`, or null when neither the daemon hostname nor the host label is known. */
  host: string | null;
  /** `\w`, or null when there is no working directory. */
  path: string | null;
}

const HOME_PATTERNS: readonly RegExp[] = [
  /^(\/Users\/([^/]+))(?=\/|$)/,
  /^(\/home\/([^/]+))(?=\/|$)/,
  /^([A-Za-z]:[\\/]Users[\\/]([^\\/]+))(?=[\\/]|$)/,
];
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function resolveHome(cwd: string): { home: string; user: string } | null {
  if (cwd === "/root" || cwd.startsWith("/root/")) {
    return { home: "/root", user: "root" };
  }
  for (const pattern of HOME_PATTERNS) {
    const match = pattern.exec(cwd);
    if (match?.[1] && match[2]) {
      return { home: match[1], user: match[2] };
    }
  }
  return null;
}

/** `\h` is the hostname up to the first dot; an IP address stays whole. */
function shortHostname(hostname: string): string {
  return IPV4_PATTERN.test(hostname) ? hostname : (hostname.split(".")[0] ?? hostname);
}

export function resolveShellPrompt(input: {
  cwd: string | null | undefined;
  hostname: string | null | undefined;
  hostLabel?: string | null;
}): ShellPromptParts {
  const trimmedCwd = input.cwd?.trim() ?? "";
  const cwd = trimmedCwd.length > 1 ? trimmedCwd.replace(/[\\/]+$/, "") : trimmedCwd;
  const home = cwd ? resolveHome(cwd) : null;
  return { user: home?.user ?? null, host: resolveHost(input), path: resolvePath(cwd, home) };
}

function resolvePath(cwd: string, home: { home: string } | null): string | null {
  if (!cwd) return null;
  return home ? `~${cwd.slice(home.home.length)}` : cwd;
}

function resolveHost(input: {
  hostname: string | null | undefined;
  hostLabel?: string | null;
}): string | null {
  const hostname = input.hostname?.trim();
  if (hostname) return shortHostname(hostname);
  return input.hostLabel?.trim() || null;
}

/** The prompt as plain text, e.g. for an accessibility label or a test. */
export function formatShellPrompt(parts: ShellPromptParts, options: { compact: boolean }): string {
  const identity = options.compact ? "" : formatIdentity(parts);
  if (!parts.path) return `${identity}$`;
  return identity ? `${identity}:${parts.path}$` : `${parts.path}$`;
}

/** `user@host`, `host`, or "" when neither is known. */
export function formatIdentity(parts: ShellPromptParts): string {
  if (parts.user && parts.host) return `${parts.user}@${parts.host}`;
  return parts.host ?? "";
}
