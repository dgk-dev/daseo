import { describe, expect, it } from "vitest";
import { parseDurationString } from "./mcp-shared.js";

describe("parseDurationString", () => {
  it("accepts a day unit", () => {
    expect(parseDurationString("2d")).toBe(172_800_000);
    expect(parseDurationString("3d")).toBe(259_200_000);
    expect(parseDurationString("1d12h")).toBe(129_600_000);
    expect(parseDurationString(" 1d ")).toBe(86_400_000);
  });

  it("keeps every form it accepted before the day unit", () => {
    expect(parseDurationString("30")).toBe(30_000);
    expect(parseDurationString("30s")).toBe(30_000);
    expect(parseDurationString("5m")).toBe(300_000);
    expect(parseDurationString("1h")).toBe(3_600_000);
    expect(parseDurationString("2h30m")).toBe(9_000_000);
    expect(parseDurationString("48h")).toBe(parseDurationString("2d"));
    // The scan still accepts any string with a match and ignores the rest (unchanged on purpose).
    expect(parseDurationString("about 5m please")).toBe(300_000);
    expect(parseDurationString("5mx")).toBe(300_000);
  });

  it("still rejects strings with no unit match and names the day unit in its examples", () => {
    for (const input of ["", "abc", "d", "5w", "-"]) {
      expect(() => parseDurationString(input)).toThrow(
        `Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m, 2d, 1d12h`,
      );
    }
  });
});
