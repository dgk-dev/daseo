import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FOOTPRINT_TIMEOUT_MS = 10_000;

/**
 * macOS memory footprint per process, as Activity Monitor's "Memory" column counts it (dirty,
 * compressed, and swapped pages; resident size undercounts a renderer macOS has compressed).
 * Read on demand for the tab report only (delta 97): `footprint` takes about 0.1 s for a few
 * renderers. A process that is gone, or a platform without the tool, is left out rather than
 * guessed from another measure.
 */
export async function measureProcessFootprints(
  pids: readonly number[],
): Promise<Map<number, number>> {
  if (process.platform !== "darwin" || pids.length === 0) {
    return new Map();
  }
  const reportPath = path.join(tmpdir(), `daseo-tab-footprint-${randomUUID()}.json`);
  try {
    // footprint exits non-zero when one of several pids is gone and still reports the others.
    await new Promise<void>((resolve) => {
      execFile(
        "footprint",
        ["--noCategories", "-j", reportPath, ...pids.flatMap((pid) => ["-p", String(pid)])],
        { timeout: FOOTPRINT_TIMEOUT_MS },
        () => resolve(),
      );
    });
    return parseFootprintReport(JSON.parse(await readFile(reportPath, "utf8")));
  } catch {
    return new Map();
  } finally {
    await rm(reportPath, { force: true });
  }
}

/** `footprint -j` output: `{ processes: [{ pid, footprint (bytes), ... }] }`. */
export function parseFootprintReport(report: unknown): Map<number, number> {
  const bytesByPid = new Map<number, number>();
  const processes =
    typeof report === "object" && report !== null
      ? (report as { processes?: unknown }).processes
      : undefined;
  if (!Array.isArray(processes)) {
    return bytesByPid;
  }
  for (const entry of processes) {
    if (typeof entry !== "object" || entry === null) continue;
    const { pid, footprint } = entry as { pid?: unknown; footprint?: unknown };
    if (
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof footprint === "number" &&
      Number.isFinite(footprint) &&
      footprint >= 0
    ) {
      bytesByPid.set(pid, Math.round(footprint));
    }
  }
  return bytesByPid;
}
