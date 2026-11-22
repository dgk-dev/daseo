import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_BUNDLE_ENV,
  ClientLoginLog,
  DEV_MOTD_FILE_ENV,
  DISK_PATH_ENV,
  FileTooLargeError,
  collectLoginBannerFacts,
  diskNotes,
  formatBannerBytes,
  parseDarwinAvailableBytes,
  parseDarwinSwapUsedBytes,
  parseMeminfoBytes,
  readFileBounded,
  type LoginBannerHost,
} from "./login-banner.js";

const VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                               10000.",
  "Pages active:                            500000.",
  "Pages inactive:                           20000.",
  "Pages speculative:                         5000.",
  "Pages wired down:                        200000.",
  "Pages purgeable:                           1000.",
].join("\n");

const GIB = 1024 ** 3;
const NOW = Date.parse("2026-11-22T12:05:00.000Z");
const HOME = "/Users/someone";
const MOTD_PATH = `${HOME}/.cache/dev-motd/motd.json`;
const OWN_PLIST = "/Applications/Daseo.app/Contents/Info.plist";
const STAGED_PLIST = `${HOME}/Applications/Paseo Local Patch.app/Contents/Info.plist`;
const DAEMON_EXEC =
  "/Applications/Daseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";

function plist(version: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "  <key>CFBundleName</key>",
    "  <string>Paseo</string>",
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${version}</string>`,
    "</dict></plist>",
  ].join("\n");
}

/** Files by path; a missing path reads as no file. */
function files(entries: Record<string, string>): LoginBannerHost["readFileBounded"] {
  return async (filePath, maxBytes) => {
    const content = entries[filePath];
    if (content === undefined) return null;
    if (Buffer.byteLength(content) > maxBytes) throw new FileTooLargeError(filePath, maxBytes);
    return content;
  };
}

function host(overrides: Partial<LoginBannerHost> = {}): LoginBannerHost {
  return {
    platform: "darwin",
    osType: "Darwin",
    osRelease: "27.2.0",
    arch: "arm64",
    loadAverage: [2.31, 2, 1.5],
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 1024 ** 3,
    run: async (command) => {
      if (command === "vm_stat") return VM_STAT;
      return "total = 8192.00M  used = 4300.80M  free = 3891.20M  (encrypted)";
    },
    readTextFile: async () => {
      throw new Error("not linux");
    },
    homeDir: HOME,
    execPath: "/usr/local/bin/node",
    env: {},
    now: () => NOW,
    statfs: async () => ({ totalBytes: 460 * GIB, availableBytes: 124 * GIB }),
    readFileBounded: files({}),
    ...overrides,
  };
}

describe("collectLoginBannerFacts", () => {
  it("reports every fact a mac can measure", async () => {
    const facts = await collectLoginBannerFacts({
      agentsRunning: 3,
      lastLogin: { at: 1_795_000_000_000, from: "android" },
      daemonVersion: "0.5.151",
      host: host(),
    });
    expect(facts).toEqual({
      os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
      loadAverage1m: 2.31,
      agentsRunning: 3,
      memory: { usedBytes: 32 * 1024 ** 3 - 36000 * 16384, totalBytes: 32 * 1024 ** 3 },
      swap: { usedBytes: Math.round(4300.8 * 1024 ** 2) },
      lastLogin: { at: 1_795_000_000_000, from: "android" },
      disk: { usedBytes: 336 * GIB, totalBytes: 460 * GIB },
    });
  });

  it("leaves out what the host cannot measure instead of sending zeros", async () => {
    const facts = await collectLoginBannerFacts({
      agentsRunning: null,
      lastLogin: null,
      daemonVersion: null,
      host: host({
        run: async () => {
          throw new Error("command missing");
        },
        statfs: async () => {
          throw new Error("no volume");
        },
      }),
    });
    expect(facts).toEqual({
      os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
      loadAverage1m: 2.31,
    });
  });

  it("has no load average or swap on Windows and no client name when none was declared", async () => {
    const facts = await collectLoginBannerFacts({
      agentsRunning: 0,
      lastLogin: { at: 5, from: null },
      daemonVersion: null,
      host: host({ platform: "win32", osType: "Windows_NT", loadAverage: [0, 0, 0] }),
    });
    expect(facts.loadAverage1m).toBeUndefined();
    expect(facts.swap).toBeUndefined();
    expect(facts.agentsRunning).toBe(0);
    expect(facts.memory).toEqual({ usedBytes: 31 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 });
    expect(facts.lastLogin).toEqual({ at: 5 });
  });

  it("reads Linux memory and swap from /proc/meminfo", async () => {
    const meminfo = [
      "MemTotal:       16000000 kB",
      "MemAvailable:    4000000 kB",
      "SwapTotal:       2000000 kB",
      "SwapFree:        1500000 kB",
    ].join("\n");
    const facts = await collectLoginBannerFacts({
      agentsRunning: 1,
      lastLogin: null,
      daemonVersion: null,
      host: host({
        platform: "linux",
        osType: "Linux",
        totalMemoryBytes: 16_000_000 * 1024,
        readTextFile: async () => meminfo,
      }),
    });
    expect(facts.memory).toEqual({
      usedBytes: 12_000_000 * 1024,
      totalBytes: 16_000_000 * 1024,
    });
    expect(facts.swap).toEqual({ usedBytes: 500_000 * 1024 });
  });
});

async function bannerWith(overrides: Partial<LoginBannerHost>, daemonVersion = "0.5.151") {
  return collectLoginBannerFacts({
    agentsRunning: 0,
    lastLogin: null,
    daemonVersion,
    host: host(overrides),
  });
}

function motd(body: Record<string, unknown>): string {
  return JSON.stringify({ schema: 1, generatedAt: "2026-11-22T12:02:59.272Z", ...body });
}

describe("disk usage (delta 144)", () => {
  it("reports the home volume as used = total - available, like df", async () => {
    const statted: string[] = [];
    const facts = await bannerWith({
      statfs: async (filePath) => {
        statted.push(filePath);
        return { totalBytes: 460 * GIB, availableBytes: 124 * GIB };
      },
    });
    expect(statted).toEqual([HOME]);
    expect(facts.disk).toEqual({ usedBytes: 336 * GIB, totalBytes: 460 * GIB });
    expect(facts.notes).toBeUndefined();
  });

  it("reads the volume of the override path", async () => {
    const statted: string[] = [];
    await bannerWith({
      env: { [DISK_PATH_ENV]: "/Volumes/Tiny" },
      statfs: async (filePath) => {
        statted.push(filePath);
        return { totalBytes: GIB, availableBytes: GIB };
      },
    });
    expect(statted).toEqual(["/Volumes/Tiny"]);
  });

  it("warns at 85% used or under 40GB free, and is critical under 25GB free", () => {
    const disk = (totalGib: number, freeGib: number) => ({
      usedBytes: (totalGib - freeGib) * GIB,
      totalBytes: totalGib * GIB,
    });
    // 84.9% used with 69.5GB free: nothing.
    expect(diskNotes(disk(460, 69.46))).toEqual([]);
    expect(diskNotes(disk(460, 69))).toEqual([
      { severity: "warning", text: "/ is using 85.0% of 460GB" },
    ]);
    // 1TB disk at 96.1% used is still over 40GB free: Ubuntu's 85% rule warns.
    expect(diskNotes(disk(1024, 40))).toEqual([
      { severity: "warning", text: "/ is using 96.1% of 1024GB" },
    ]);
    // 200GB disk at 80% used: 40GB free is not < 40, 39.9GB is.
    expect(diskNotes(disk(200, 40))).toEqual([]);
    expect(diskNotes(disk(200, 39.9))).toEqual([
      { severity: "warning", text: "/ is using 80.0% of 200GB" },
    ]);
    // 25GB free is a warning, under 25GB critical.
    expect(diskNotes(disk(200, 25))).toEqual([
      { severity: "warning", text: "/ is using 87.5% of 200GB" },
    ]);
    expect(diskNotes(disk(460, 24.9))).toEqual([
      { severity: "critical", text: "/ is using 94.6% of 460GB" },
    ]);
  });

  it("leaves out a volume that reports impossible sizes", async () => {
    const facts = await bannerWith({
      statfs: async () => ({ totalBytes: 0, availableBytes: 0 }),
    });
    expect(facts.disk).toBeUndefined();
  });

  it("formats bytes the way the app's banner does", () => {
    expect(formatBannerBytes(460.43 * GIB)).toBe("460.4GB");
    expect(formatBannerBytes(32 * GIB)).toBe("32GB");
    expect(formatBannerBytes(512 * 1024 ** 2)).toBe("512MB");
  });
});

describe("dev motd file (delta 144)", () => {
  it("adds nothing when the host has no motd file", async () => {
    const facts = await bannerWith({});
    expect(facts.extraHeaders).toBeUndefined();
    expect(facts.notes).toBeUndefined();
  });

  it("adds its headers and notes, after Daseo's own disk note", async () => {
    const facts = await bannerWith({
      statfs: async () => ({ totalBytes: 460 * GIB, availableBytes: 64 * GIB }),
      readFileBounded: files({
        [MOTD_PATH]: motd({
          headers: [{ label: "Dev servers:", value: "2 (3.1GB)" }],
          notes: [
            { severity: "warning", text: "Memory pressure is high: Google Chrome 3.1GB" },
            { severity: "critical", text: "Swap is using 21.0GB" },
          ],
          unknownField: { ignored: true },
        }),
      }),
    });
    expect(facts.extraHeaders).toEqual([{ label: "Dev servers:", value: "2 (3.1GB)" }]);
    expect(facts.notes).toEqual([
      { severity: "warning", text: "/ is using 86.1% of 460GB" },
      { severity: "warning", text: "Memory pressure is high: Google Chrome 3.1GB" },
      { severity: "critical", text: "Swap is using 21.0GB" },
    ]);
  });

  it("reads the override path", async () => {
    const facts = await bannerWith({
      env: { [DEV_MOTD_FILE_ENV]: "/tmp/fixture-motd.json" },
      readFileBounded: files({
        "/tmp/fixture-motd.json": motd({ headers: [{ label: "Dev servers:", value: "0" }] }),
      }),
    });
    expect(facts.extraHeaders).toEqual([{ label: "Dev servers:", value: "0" }]);
  });

  it("drops malformed entries, folds line breaks, and caps headers at 4 and notes at 6", async () => {
    const facts = await bannerWith({
      readFileBounded: files({
        [MOTD_PATH]: motd({
          headers: [
            { label: "A:", value: "1" },
            { label: "", value: "empty label" },
            { label: "B:", value: 2 },
            "not an object",
            { label: "C:", value: "3" },
            { label: "D:", value: "4" },
            { label: "E:", value: "5" },
            { label: "F:", value: "6" },
          ],
          notes: [
            { severity: "info", text: "unknown severity" },
            { severity: "warning", text: "   " },
            { severity: "warning", text: "line one\nline two\t end " },
            ...Array.from({ length: 8 }, (_, index) => ({
              severity: "warning",
              text: `n${index}`,
            })),
          ],
        }),
      }),
    });
    expect(facts.extraHeaders).toEqual([
      { label: "A:", value: "1" },
      { label: "C:", value: "3" },
      { label: "D:", value: "4" },
      { label: "E:", value: "5" },
    ]);
    expect(facts.notes?.map((note) => note.text)).toEqual([
      "line one line two end",
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
    ]);
  });

  it("ignores a file that is not schema 1 JSON with a valid generatedAt", async () => {
    for (const content of [
      "{not json",
      JSON.stringify([1, 2]),
      JSON.stringify({ schema: 2, generatedAt: "2026-11-22T12:02:59Z", notes: [] }),
      JSON.stringify({
        schema: 1,
        generatedAt: "yesterday",
        headers: [{ label: "A:", value: "1" }],
      }),
    ]) {
      const facts = await bannerWith({ readFileBounded: files({ [MOTD_PATH]: content }) });
      expect(facts.extraHeaders).toBeUndefined();
      expect(facts.notes).toBeUndefined();
    }
  });

  it("ignores a file over 64KB", async () => {
    const facts = await bannerWith({
      readFileBounded: files({
        [MOTD_PATH]: motd({
          headers: [{ label: "Dev servers:", value: "1" }],
          padding: "x".repeat(64 * 1024),
        }),
      }),
    });
    expect(facts.extraHeaders).toBeUndefined();
    expect(facts.notes).toBeUndefined();
  });

  it("replaces a file older than 10 minutes with one warning, minutes rounded down", async () => {
    const generatedAt = new Date(NOW - 25 * 60_000 - 59_000).toISOString();
    const facts = await bannerWith({
      readFileBounded: files({
        [MOTD_PATH]: motd({
          generatedAt,
          headers: [{ label: "Dev servers:", value: "1" }],
          notes: [{ severity: "critical", text: "Swap is using 21.0GB" }],
        }),
      }),
    });
    expect(facts.extraHeaders).toBeUndefined();
    expect(facts.notes).toEqual([
      { severity: "warning", text: "dev-memory-guard has not reported for 25 minutes" },
    ]);
  });

  it("still shows a file exactly 10 minutes old", async () => {
    const facts = await bannerWith({
      readFileBounded: files({
        [MOTD_PATH]: motd({
          generatedAt: new Date(NOW - 10 * 60_000).toISOString(),
          headers: [{ label: "Dev servers:", value: "1" }],
        }),
      }),
    });
    expect(facts.extraHeaders).toEqual([{ label: "Dev servers:", value: "1" }]);
  });
});

describe("restart required (delta 144)", () => {
  const packaged = { execPath: DAEMON_EXEC };

  it("names the staged build while its replacement waits", async () => {
    const facts = await bannerWith({
      ...packaged,
      readFileBounded: files({ [OWN_PLIST]: plist("0.5.151"), [STAGED_PLIST]: plist("0.5.152") }),
    });
    expect(facts.restartRequired).toEqual({ version: "0.5.152" });
  });

  it("names the daemon's own bundle when the app was replaced and the daemon survived", async () => {
    const facts = await bannerWith({
      ...packaged,
      readFileBounded: files({ [OWN_PLIST]: plist("0.5.152"), [STAGED_PLIST]: plist("0.5.152") }),
    });
    expect(facts.restartRequired).toEqual({ version: "0.5.152" });
  });

  it("says nothing after a completed activation or when only an older build is on disk", async () => {
    for (const [own, staged] of [
      ["0.5.151", "0.5.151"],
      ["0.5.151", "0.5.150"],
      ["0.5.151", undefined],
    ] as const) {
      const facts = await bannerWith({
        ...packaged,
        readFileBounded: files({
          [OWN_PLIST]: plist(own),
          ...(staged ? { [STAGED_PLIST]: plist(staged) } : {}),
        }),
      });
      expect(facts.restartRequired).toBeUndefined();
    }
  });

  it("compares versions numerically, not as text", async () => {
    const facts = await bannerWith(
      {
        ...packaged,
        readFileBounded: files({ [OWN_PLIST]: plist("0.5.9"), [STAGED_PLIST]: plist("0.5.10") }),
      },
      "0.5.9",
    );
    expect(facts.restartRequired).toEqual({ version: "0.5.10" });
  });

  it("says nothing for a daemon outside an app bundle, such as a checkout's dev daemon", async () => {
    const facts = await bannerWith({
      execPath: "/opt/homebrew/bin/node",
      readFileBounded: files({ [STAGED_PLIST]: plist("0.5.152") }),
    });
    expect(facts.restartRequired).toBeUndefined();
  });

  it("uses the override bundle in place of the daemon's own", async () => {
    const facts = await bannerWith({
      env: { [APP_BUNDLE_ENV]: "/tmp/Fixture.app" },
      readFileBounded: files({ "/tmp/Fixture.app/Contents/Info.plist": plist("0.5.152") }),
    });
    expect(facts.restartRequired).toEqual({ version: "0.5.152" });
  });

  it("ignores unreadable plists and non-mac hosts", async () => {
    const unreadable = await bannerWith({
      ...packaged,
      readFileBounded: async () => {
        throw new Error("EACCES");
      },
    });
    expect(unreadable.restartRequired).toBeUndefined();
    const linux = await bannerWith({
      ...packaged,
      platform: "linux",
      readTextFile: async () => "",
      readFileBounded: files({ [STAGED_PLIST]: plist("0.5.152") }),
    });
    expect(linux.restartRequired).toBeUndefined();
  });
});

describe("readFileBounded", () => {
  it("reads a small file, gives null for a missing one, and rejects one over the bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "login-banner-"));
    try {
      const small = path.join(dir, "small.json");
      const large = path.join(dir, "large.json");
      await writeFile(small, "x".repeat(16));
      await writeFile(large, "x".repeat(17));
      expect(await readFileBounded(small, 16)).toBe("x".repeat(16));
      expect(await readFileBounded(path.join(dir, "missing.json"), 16)).toBeNull();
      await expect(readFileBounded(large, 16)).rejects.toBeInstanceOf(FileTooLargeError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parsers", () => {
  it("rejects output they do not recognise", () => {
    expect(parseDarwinAvailableBytes("nothing")).toBeNull();
    expect(parseDarwinAvailableBytes(VM_STAT.replace("Pages purgeable", "Pages other"))).toBeNull();
    expect(parseDarwinSwapUsedBytes("vm.swapusage: unknown")).toBeNull();
    expect(parseMeminfoBytes("MemTotal: 1 kB", "SwapFree")).toBeNull();
  });
});

describe("ClientLoginLog", () => {
  it("returns the login before the asking client's own", () => {
    const log = new ClientLoginLog();
    expect(log.previousFor("phone")).toBeNull();
    log.record({ clientId: "mac", at: 10, from: "web" });
    expect(log.previousFor("mac")).toBeNull();
    log.record({ clientId: "phone", at: 20, from: "android" });
    expect(log.previousFor("phone")).toEqual({ at: 10, from: "web" });
    log.record({ clientId: "mac", at: 30, from: null });
    expect(log.previousFor("mac")).toEqual({ at: 20, from: "android" });
    expect(log.previousFor("phone")).toEqual({ at: 10, from: "web" });
  });

  it("keeps a bounded history", () => {
    const log = new ClientLoginLog(2);
    log.record({ clientId: "a", at: 1, from: null });
    log.record({ clientId: "b", at: 2, from: null });
    log.record({ clientId: "c", at: 3, from: null });
    expect(log.previousFor("c")).toEqual({ at: 2, from: null });
    expect(log.previousFor("b")).toBeNull();
  });
});
