import { open, readFile, statfs } from "node:fs/promises";
import { freemem, homedir, loadavg, platform, release, totalmem, type } from "node:os";
import path from "node:path";

import type { SessionOutboundMessage } from "../messages.js";
import { execCommand } from "../../utils/spawn.js";
import { DEV_MOTD_MAX_BYTES, parseDevMotd, type DevMotd } from "./dev-motd.js";
import {
  infoPlistPaths,
  newerInstalledVersion,
  parseBundleShortVersion,
  resolveOwnAppBundle,
} from "./restart-required.js";

/**
 * Daseo: host facts for the login banner an empty chat shows (`daemon.get_login_banner.request`).
 * Every fact is measured on this host when asked; one that cannot be measured is left out, so
 * the app never has a number to show that nobody read.
 */
export type LoginBannerFacts = Omit<
  Extract<SessionOutboundMessage, { type: "daemon.get_login_banner.response" }>["payload"],
  "requestId"
>;

export type LoginBannerHeader = NonNullable<LoginBannerFacts["extraHeaders"]>[number];
export type LoginBannerNote = NonNullable<LoginBannerFacts["notes"]>[number];

export interface LoginBannerUsage {
  usedBytes: number;
  totalBytes: number;
}

export interface LoginBannerHost {
  platform: NodeJS.Platform;
  osType: string;
  osRelease: string;
  arch: string;
  loadAverage: readonly number[];
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  /** Runs a command and returns its stdout; rejects when it fails. */
  run: (command: string, args: string[]) => Promise<string>;
  readTextFile: (filePath: string) => Promise<string>;
  /** Daseo delta 144 */
  homeDir: string;
  /** The daemon's executable; inside an app bundle when the daemon is a packaged build. */
  execPath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  statfs: (filePath: string) => Promise<{ totalBytes: number; availableBytes: number }>;
  /** The file's text, null when it does not exist; rejects when it is larger than `maxBytes`. */
  readFileBounded: (filePath: string, maxBytes: number) => Promise<string | null>;
}

const COMMAND_TIMEOUT_MS = 2_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const INFO_PLIST_MAX_BYTES = 256 * 1024;

/**
 * Environment overrides, for fixtures and tests: the motd file to read, the path whose volume
 * `Usage of /` reports, and an app bundle that stands in for the one the daemon runs from.
 */
export const DEV_MOTD_FILE_ENV = "DASEO_DEV_MOTD_FILE";
export const DISK_PATH_ENV = "DASEO_LOGIN_BANNER_DISK_PATH";
export const APP_BUNDLE_ENV = "DASEO_LOGIN_BANNER_APP_BUNDLE";

function realHost(): LoginBannerHost {
  return {
    platform: platform(),
    osType: type(),
    osRelease: release(),
    arch: process.arch,
    loadAverage: loadavg(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    run: async (command, args) =>
      (await execCommand(command, args, { timeout: COMMAND_TIMEOUT_MS })).stdout,
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    homeDir: homedir(),
    execPath: process.execPath,
    env: process.env,
    now: () => Date.now(),
    statfs: async (filePath) => {
      const stats = await statfs(filePath);
      return { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize };
    },
    readFileBounded,
  };
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly maxBytes: number,
  ) {
    super(`${filePath} is larger than ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

/** Reads at most `maxBytes + 1` bytes, so an oversized file costs no more than a valid one. */
export async function readFileBounded(filePath: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new FileTooLargeError(filePath, maxBytes);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function collectLoginBannerFacts(input: {
  agentsRunning: number | null;
  lastLogin: { at: number; from: string | null } | null;
  /** The running daemon's version, compared with the Daseo bundles on disk. */
  daemonVersion: string | null;
  host?: LoginBannerHost;
}): Promise<LoginBannerFacts> {
  const host = input.host ?? realHost();
  const [memory, swapUsedBytes, disk, devMotd, restartVersion] = await Promise.all([
    readMemory(host).catch(() => null),
    readSwapUsedBytes(host).catch(() => null),
    readDisk(host).catch(() => null),
    readDevMotd(host).catch(() => null),
    readRestartRequiredVersion(host, input.daemonVersion).catch(() => null),
  ]);
  const facts: LoginBannerFacts = {};
  if (host.osType && host.osRelease && host.arch) {
    facts.os = { type: host.osType, release: host.osRelease, arch: host.arch };
  }
  // Windows has no load average; Node reports zeros there.
  const load = host.loadAverage[0];
  if (host.platform !== "win32" && typeof load === "number" && Number.isFinite(load)) {
    facts.loadAverage1m = Math.max(0, load);
  }
  if (input.agentsRunning !== null) {
    facts.agentsRunning = input.agentsRunning;
  }
  if (memory) {
    facts.memory = memory;
  }
  if (swapUsedBytes !== null) {
    facts.swap = { usedBytes: swapUsedBytes };
  }
  if (input.lastLogin) {
    facts.lastLogin = {
      at: input.lastLogin.at,
      ...(input.lastLogin.from ? { from: input.lastLogin.from } : {}),
    };
  }
  return { ...facts, ...hostNotesFacts({ disk, devMotd, restartVersion }) };
}

/** Daseo delta 144: disk, the motd file's lines, and the restart line. */
function hostNotesFacts(input: {
  disk: LoginBannerUsage | null;
  devMotd: DevMotd | null;
  restartVersion: string | null;
}): LoginBannerFacts {
  const facts: LoginBannerFacts = {};
  if (input.disk) {
    facts.disk = input.disk;
  }
  if (input.devMotd && input.devMotd.headers.length > 0) {
    facts.extraHeaders = input.devMotd.headers;
  }
  // Daseo's own notes come first: disk, then the motd file's (its stale warning, or its notes).
  const notes = [...(input.disk ? diskNotes(input.disk) : []), ...(input.devMotd?.notes ?? [])];
  if (notes.length > 0) {
    facts.notes = notes;
  }
  if (input.restartVersion) {
    facts.restartRequired = { version: input.restartVersion };
  }
  return facts;
}

/**
 * The volume holding the daemon user's home: on macOS that is the Data volume, where everything
 * the user writes lands, while `/` itself is the sealed system snapshot. Used is total minus
 * available, as `df` reports it to an unprivileged user.
 */
async function readDisk(host: LoginBannerHost): Promise<LoginBannerUsage | null> {
  const target = host.env[DISK_PATH_ENV]?.trim() || host.homeDir;
  const { totalBytes, availableBytes } = await host.statfs(target);
  if (!(totalBytes > 0) || !(availableBytes >= 0) || availableBytes > totalBytes) return null;
  return { usedBytes: totalBytes - availableBytes, totalBytes };
}

/**
 * Ubuntu's landscape-sysinfo warns at 85% used (`disk.py`); a large disk can be under 85% and
 * still nearly full in absolute terms, so little free space warns too.
 */
export function diskNotes(disk: LoginBannerUsage): LoginBannerNote[] {
  const availableBytes = disk.totalBytes - disk.usedBytes;
  const percent = (disk.usedBytes / disk.totalBytes) * 100;
  const text = `/ is using ${percent.toFixed(1)}% of ${formatBannerBytes(disk.totalBytes)}`;
  if (availableBytes < 25 * GIB) return [{ severity: "critical", text }];
  if (percent >= 85 || availableBytes < 40 * GIB) return [{ severity: "warning", text }];
  return [];
}

async function readDevMotd(host: LoginBannerHost): Promise<DevMotd> {
  const filePath =
    host.env[DEV_MOTD_FILE_ENV]?.trim() || path.join(host.homeDir, ".cache/dev-motd/motd.json");
  return parseDevMotd(await host.readFileBounded(filePath, DEV_MOTD_MAX_BYTES), host.now());
}

async function readRestartRequiredVersion(
  host: LoginBannerHost,
  daemonVersion: string | null,
): Promise<string | null> {
  if (!daemonVersion || host.platform !== "darwin") return null;
  const ownBundle = host.env[APP_BUNDLE_ENV]?.trim() || resolveOwnAppBundle(host.execPath);
  if (!ownBundle) return null;
  const versions = await Promise.all(
    infoPlistPaths({ ownBundle, homeDir: host.homeDir }).map(async (plistPath) => {
      const plist = await host.readFileBounded(plistPath, INFO_PLIST_MAX_BYTES).catch(() => null);
      return plist === null ? null : parseBundleShortVersion(plist);
    }),
  );
  return newerInstalledVersion(
    daemonVersion,
    versions.filter((version): version is string => version !== null),
  );
}

/**
 * The app's banner byte style (`460GB`, `4.2GB`, `512MB`; one decimal only when it says
 * something), for the note texts the daemon writes. The app formats header values itself.
 */
export function formatBannerBytes(bytes: number): string {
  if (bytes >= GIB) {
    const fixed = (bytes / GIB).toFixed(1);
    return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}GB`;
  }
  return `${Math.round(bytes / MIB)}MB`;
}

/**
 * Used memory the way Ubuntu's banner counts it: total minus what the kernel can hand out
 * without swapping. `os.freemem()` alone counts only untouched pages on macOS and Linux, which
 * would read as a nearly full machine, so each platform is asked for its reclaimable pages.
 */
async function readMemory(host: LoginBannerHost): Promise<LoginBannerUsage | null> {
  const totalBytes = host.totalMemoryBytes;
  if (!(totalBytes > 0)) return null;
  let availableBytes: number | null = null;
  if (host.platform === "darwin") {
    availableBytes = parseDarwinAvailableBytes(await host.run("vm_stat", []));
  } else if (host.platform === "linux") {
    availableBytes = parseMeminfoBytes(await host.readTextFile("/proc/meminfo"), "MemAvailable");
  } else if (host.platform === "win32") {
    // On Windows the free figure already is the available figure.
    availableBytes = host.freeMemoryBytes;
  }
  if (availableBytes === null || availableBytes < 0 || availableBytes > totalBytes) return null;
  return { usedBytes: totalBytes - availableBytes, totalBytes };
}

async function readSwapUsedBytes(host: LoginBannerHost): Promise<number | null> {
  if (host.platform === "darwin") {
    return parseDarwinSwapUsedBytes(await host.run("sysctl", ["-n", "vm.swapusage"]));
  }
  if (host.platform === "linux") {
    const meminfo = await host.readTextFile("/proc/meminfo");
    const total = parseMeminfoBytes(meminfo, "SwapTotal");
    const free = parseMeminfoBytes(meminfo, "SwapFree");
    if (total === null || free === null || free > total) return null;
    return total - free;
  }
  return null;
}

/** `vm_stat`: free, inactive, speculative and purgeable pages can be handed out without swap. */
export function parseDarwinAvailableBytes(vmStat: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  if (!(pageSize > 0)) return null;
  let pages = 0;
  for (const label of ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"]) {
    const value = Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(vmStat)?.[1]);
    if (!Number.isFinite(value)) return null;
    pages += value;
  }
  return pages * pageSize;
}

/** `sysctl -n vm.swapusage`: `total = 4096.00M  used = 2717.25M  free = 1378.75M  (encrypted)`. */
export function parseDarwinSwapUsedBytes(swapUsage: string): number | null {
  const match = /used = ([\d.]+)([KMG])/.exec(swapUsage);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2] as "K" | "M" | "G"];
  return Math.round(value * unit);
}

/** `/proc/meminfo` rows are `Name:   12345 kB`. */
export function parseMeminfoBytes(meminfo: string, name: string): number | null {
  const value = Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]);
  return Number.isFinite(value) ? value * 1024 : null;
}

/**
 * The client connections this daemon process has accepted, newest last, so a banner can say
 * when the one before the asking client arrived. In memory only: after a daemon restart there
 * is no previous login to report and the line is left out.
 */
export class ClientLoginLog {
  private readonly entries: Array<{ clientId: string; at: number; from: string | null }> = [];

  constructor(private readonly limit = 32) {}

  record(entry: { clientId: string; at: number; from: string | null }): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  /** The login just before `clientId`'s own latest one. */
  previousFor(clientId: string): { at: number; from: string | null } | null {
    let ownIndex = -1;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]?.clientId === clientId) {
        ownIndex = index;
        break;
      }
    }
    const previous = ownIndex > 0 ? this.entries[ownIndex - 1] : undefined;
    return previous ? { at: previous.at, from: previous.from } : null;
  }
}
