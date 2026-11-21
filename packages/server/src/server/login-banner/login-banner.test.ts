import { describe, expect, it } from "vitest";

import {
  ClientLoginLog,
  collectLoginBannerFacts,
  parseDarwinAvailableBytes,
  parseDarwinSwapUsedBytes,
  parseMeminfoBytes,
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
    ...overrides,
  };
}

describe("collectLoginBannerFacts", () => {
  it("reports every fact a mac can measure", async () => {
    const facts = await collectLoginBannerFacts({
      agentsRunning: 3,
      lastLogin: { at: 1_795_000_000_000, from: "android" },
      host: host(),
    });
    expect(facts).toEqual({
      os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
      loadAverage1m: 2.31,
      agentsRunning: 3,
      memory: { usedBytes: 32 * 1024 ** 3 - 36000 * 16384, totalBytes: 32 * 1024 ** 3 },
      swap: { usedBytes: Math.round(4300.8 * 1024 ** 2) },
      lastLogin: { at: 1_795_000_000_000, from: "android" },
    });
  });

  it("leaves out what the host cannot measure instead of sending zeros", async () => {
    const facts = await collectLoginBannerFacts({
      agentsRunning: null,
      lastLogin: null,
      host: host({
        run: async () => {
          throw new Error("command missing");
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
