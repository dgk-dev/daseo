import { describe, expect, it } from "vitest";
import {
  buildLoginBanner,
  formatBytes,
  layoutLoginBanner,
  type LoginBannerFacts,
  type LoginBannerModel,
} from "./format";

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

function textOf(model: LoginBannerModel, columns: 1 | 2): string[] {
  return layoutLoginBanner(model, columns).map((line) => line.text);
}

describe("buildLoginBanner", () => {
  it("lays out every measured value on a wide pane", () => {
    const model = buildLoginBanner({ appVersion: "0.5.150", facts: FULL });
    expect(textOf(model, 2)).toEqual([
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
    expect(textOf(model, 1)).toEqual([
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
    expect(textOf(buildLoginBanner({ appVersion: "0.5.150", facts: null }), 2)).toEqual([
      "Welcome to Daseo 0.5.150",
    ]);
    expect(textOf(buildLoginBanner({ appVersion: null, facts: {} }), 2)).toEqual([
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
    expect(textOf(model, 2)).toEqual([
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

// The delta 144 target on a wide pane.
const WITH_NOTES: LoginBannerFacts = {
  os: { type: "Darwin", release: "27.2.0", arch: "arm64" },
  loadAverage1m: 13.92,
  agentsRunning: 10,
  disk: { usedBytes: 0.73 * 460 * GIB, totalBytes: 460 * GIB },
  extraHeaders: [{ label: "Dev servers:", value: "2 (3.1GB)" }],
  memory: { usedBytes: 0.56 * 24 * GIB, totalBytes: 24 * GIB },
  swap: { usedBytes: 2.4 * GIB },
  notes: [
    { severity: "warning", text: "/ is using 86.0% of 460GB" },
    { severity: "warning", text: "Idle for 3h: Google Chrome 3.1GB. Quitting frees about 3.1GB" },
    { severity: "critical", text: "Memory pressure is critical: next-server (office) 5.2GB" },
  ],
  restartRequired: { version: "0.5.152" },
  lastLogin: { at: LOGIN_AT, from: "fold7" },
};

describe("login banner notes (delta 144)", () => {
  it("puts Usage of / and the extra headers between agents and memory, then notes and restart", () => {
    const model = buildLoginBanner({ appVersion: "0.5.151", facts: WITH_NOTES });
    expect(textOf(model, 2)).toEqual([
      "Welcome to Daseo 0.5.151 (Darwin 27.2.0 arm64)",
      "",
      "  System load:  13.92            Agents running: 10",
      "  Usage of /:   73.0% of 460GB   Dev servers:    2 (3.1GB)",
      "  Memory usage: 56% of 24GB      Swap usage:     2.4GB",
      "",
      "=> Memory pressure is critical: next-server (office) 5.2GB",
      "=> / is using 86.0% of 460GB",
      "=> Idle for 3h: Google Chrome 3.1GB. Quitting frees about 3.1GB",
      "",
      "*** Daseo 0.5.152 is installed; restart required ***",
      "",
      "Last login: Sat Nov 21 14:02:11 2026 from fold7",
    ]);
  });

  it("colours notes by severity and the restart line as normal text", () => {
    const lines = layoutLoginBanner(
      buildLoginBanner({ appVersion: "0.5.151", facts: WITH_NOTES }),
      1,
    );
    const tones = Object.fromEntries(lines.map((line) => [line.text, line.tone]));
    expect(tones["=> Memory pressure is critical: next-server (office) 5.2GB"]).toBe("critical");
    expect(tones["=> / is using 86.0% of 460GB"]).toBe("warning");
    expect(tones["*** Daseo 0.5.152 is installed; restart required ***"]).toBe("notice");
    expect(tones["  Usage of /:     73.0% of 460GB"]).toBe("muted");
    expect(tones["Last login: Sat Nov 21 14:02:11 2026 from fold7"]).toBe("muted");
  });

  it("keeps the daemon's order within a severity, shows at most six, and reads an unknown level as a warning", () => {
    const model = buildLoginBanner({
      appVersion: null,
      facts: {
        notes: [
          { severity: "warning", text: "w1" },
          { severity: "info", text: "w2" },
          { severity: "critical", text: "c1" },
          { severity: "warning", text: "w3" },
          { severity: "critical", text: "c2" },
          { severity: "warning", text: "w4" },
          { severity: "warning", text: "w5" },
          { severity: "warning", text: "   " },
        ],
      },
    });
    expect(model.notes).toEqual([
      { severity: "critical", text: "c1" },
      { severity: "critical", text: "c2" },
      { severity: "warning", text: "w1" },
      { severity: "warning", text: "w2" },
      { severity: "warning", text: "w3" },
      { severity: "warning", text: "w4" },
    ]);
  });

  it("cuts a note longer than 120 characters with an ellipsis", () => {
    const long = "x".repeat(150);
    const model = buildLoginBanner({
      appVersion: null,
      facts: {
        notes: [
          { severity: "warning", text: long },
          { severity: "warning", text: "y".repeat(120) },
        ],
      },
    });
    expect(model.notes[0]?.text).toBe(`${"x".repeat(119)}…`);
    expect(model.notes[0]?.text).toHaveLength(120);
    expect(model.notes[1]?.text).toBe("y".repeat(120));
  });

  it("shows the stale-guard note the daemon sends like any other warning", () => {
    const model = buildLoginBanner({
      appVersion: "0.5.151",
      facts: {
        notes: [{ severity: "warning", text: "dev-memory-guard has not reported for 25 minutes" }],
      },
    });
    expect(textOf(model, 2)).toEqual([
      "Welcome to Daseo 0.5.151",
      "",
      "=> dev-memory-guard has not reported for 25 minutes",
    ]);
  });

  it("without a motd file is today's banner plus Usage of /", () => {
    const model = buildLoginBanner({
      appVersion: "0.5.150",
      facts: { ...FULL, disk: { usedBytes: 336 * GIB, totalBytes: 460 * GIB } },
    });
    expect(textOf(model, 2)).toEqual([
      "Welcome to Daseo 0.5.150 (Darwin 27.2.0 arm64)",
      "",
      "  System load: 2.31             Agents running: 3",
      "  Usage of /:  73.0% of 460GB   Memory usage:   71% of 32GB",
      "  Swap usage:  4.2GB",
      "",
      "Last login: Sat Nov 21 14:02:11 2026 from android",
    ]);
  });

  it("drops a disk that cannot be true", () => {
    const model = buildLoginBanner({
      appVersion: null,
      facts: { disk: { usedBytes: 2 * GIB, totalBytes: GIB } },
    });
    expect(model.pairs).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("uses whole gigabytes when exact and megabytes below one", () => {
    expect(formatBytes(32 * GIB)).toBe("32GB");
    expect(formatBytes(4.26 * GIB)).toBe("4.3GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300MB");
  });
});
