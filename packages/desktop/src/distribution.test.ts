import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DASEO_DISTRIBUTION_MARKER, isDaseoDistribution } from "./distribution.js";

describe("desktop distribution identity", () => {
  it("requires the packaged Daseo marker instead of inferring from display text", () => {
    const resources = mkdtempSync(path.join(tmpdir(), "daseo-distribution-"));
    try {
      expect(isDaseoDistribution(resources)).toBe(false);
      writeFileSync(path.join(resources, DASEO_DISTRIBUTION_MARKER), '{"distribution":"daseo"}\n');
      expect(isDaseoDistribution(resources)).toBe(true);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});
