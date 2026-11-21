import { readFile } from "node:fs/promises";
import { freemem, loadavg, platform, release, totalmem, type } from "node:os";

import type { SessionOutboundMessage } from "../messages.js";
import { execCommand } from "../../utils/spawn.js";

/**
 * Daseo: host facts for the login banner an empty chat shows (`daemon.get_login_banner.request`).
 * Every fact is measured on this host when asked; one that cannot be measured is left out, so
 * the app never has a number to show that nobody read.
 */
export type LoginBannerFacts = Omit<
  Extract<SessionOutboundMessage, { type: "daemon.get_login_banner.response" }>["payload"],
  "requestId"
>;

export interface LoginBannerMemory {
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
}

const COMMAND_TIMEOUT_MS = 2_000;

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
  };
}

export async function collectLoginBannerFacts(input: {
  agentsRunning: number | null;
  lastLogin: { at: number; from: string | null } | null;
  host?: LoginBannerHost;
}): Promise<LoginBannerFacts> {
  const host = input.host ?? realHost();
  const [memory, swapUsedBytes] = await Promise.all([
    readMemory(host).catch(() => null),
    readSwapUsedBytes(host).catch(() => null),
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
  return facts;
}

/**
 * Used memory the way Ubuntu's banner counts it: total minus what the kernel can hand out
 * without swapping. `os.freemem()` alone counts only untouched pages on macOS and Linux, which
 * would read as a nearly full machine, so each platform is asked for its reclaimable pages.
 */
async function readMemory(host: LoginBannerHost): Promise<LoginBannerMemory | null> {
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
