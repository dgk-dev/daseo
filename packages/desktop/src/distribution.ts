import { existsSync } from "node:fs";
import path from "node:path";

export const DASEO_DISTRIBUTION_MARKER = "daseo-distribution.json";

export function isDaseoDistribution(resourcesPath = process.resourcesPath): boolean {
  if (process.env.DASEO_DISTRIBUTION === "1") return true;
  return typeof resourcesPath === "string" && resourcesPath.length > 0
    ? existsSync(path.join(resourcesPath, DASEO_DISTRIBUTION_MARKER))
    : false;
}
