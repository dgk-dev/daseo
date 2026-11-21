import { describe, expect, it } from "vitest";
import { buildLoginBanner, formatBytes, layoutLoginBanner } from "./format";

const GIB = 1024 ** 3;
// Local-time constructor, so the expected text does not depend on the machine's time zone.
const LOGIN_AT = new Date(2026, 10, 21, 14, 2, 11).getTime();

const FULL = {
  os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
  loadAverage1m: 2.314,
  agentsRunning: 3,
  memory: { usedBytes: 0.71 * 32 * GIB, totalBytes: 32 * GIB },
  swap: { usedBytes: 4.2 * GIB },
  lastLogin: { at: LOGIN_AT, from: "android" },
};

describe("buildLoginBanner", () => {
  it("lays out every measured value on a wide pane", () => {
    const model = buildLoginBanner({ appVersion: "0.5.150", facts: FULL });
    expect(layoutLoginBanner(model, 2)).toEqual([
      "Welcome to Daseo 0.5.150 (Darwin 27.2.0 arm64)",
      "",
      "  System load:  2.31          Agents running: 3",
      "  Memory usage: 71% of 32GB   Swap usage:     4.2GB",
      "",
      "Last login: Sat Nov 21 14:02:11 2026 from android",
    ]);
  });

  it("puts one pair on a line on a phone", () => {
    const model = buildLoginBanner({ appVersion: "0.5.150", facts: FULL });
    expect(layoutLoginBanner(model, 1)).toEqual([
      "Welcome to Daseo 0.5.150 (Darwin 27.2.0 arm64)",
      "",
      "  System load:    2.31",
      "  Agents running: 3",
      "  Memory usage:   71% of 32GB",
      "  Swap usage:     4.2GB",
      "",
      "Last login: Sat Nov 21 14:02:11 2026 from android",
    ]);
  });

  it("shows only the welcome line when the daemon sent nothing", () => {
    expect(layoutLoginBanner(buildLoginBanner({ appVersion: "0.5.150", facts: null }), 2)).toEqual([
      "Welcome to Daseo 0.5.150",
    ]);
    expect(layoutLoginBanner(buildLoginBanner({ appVersion: null, facts: {} }), 2)).toEqual([
      "Welcome to Daseo",
    ]);
  });

  it("drops a missing value together with its label, never a placeholder", () => {
    const model = buildLoginBanner({
      appVersion: "0.5.150",
      facts: {
        loadAverage1m: 0.5,
        swap: { usedBytes: 512 * 1024 ** 2 },
        lastLogin: { at: LOGIN_AT },
      },
    });
    expect(model.pairs).toEqual([
      { label: "System load:", value: "0.50" },
      { label: "Swap usage:", value: "512MB" },
    ]);
    expect(layoutLoginBanner(model, 2)).toEqual([
      "Welcome to Daseo 0.5.150",
      "",
      "  System load: 0.50   Swap usage: 512MB",
      "",
      "Last login: Sat Nov 21 14:02:11 2026",
    ]);
  });

  it("keeps a real zero and rejects values that cannot be true", () => {
    const model = buildLoginBanner({
      appVersion: null,
      facts: {
        agentsRunning: 0,
        loadAverage1m: Number.NaN,
        memory: { usedBytes: 2 * GIB, totalBytes: GIB },
        swap: { usedBytes: 0 },
        lastLogin: { at: 0 },
      },
    });
    expect(model.pairs).toEqual([
      { label: "Agents running:", value: "0" },
      { label: "Swap usage:", value: "0MB" },
    ]);
    expect(model.lastLogin).toBeNull();
  });
});

describe("formatBytes", () => {
  it("uses whole gigabytes when exact and megabytes below one", () => {
    expect(formatBytes(32 * GIB)).toBe("32GB");
    expect(formatBytes(4.26 * GIB)).toBe("4.3GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300MB");
  });
});
