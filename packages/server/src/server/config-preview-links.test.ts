import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-preview-links-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon preview links config (Daseo delta 75)", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("is off when no base URL is set", async () => {
    const home = await createPaseoHome({ version: 1 });
    expect(loadConfig(home, { env: {} }).previewLinks).toBeNull();
  });

  test("reads the base URL and a 30-day default TTL from config.json", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { previewLinks: { baseUrl: "https://mac.tail29eaf5.ts.net/f/" } },
    });
    expect(loadConfig(home, { env: {} }).previewLinks).toEqual({
      baseUrl: "https://mac.tail29eaf5.ts.net/f",
      ttlMs: 30 * DAY_MS,
    });
  });

  test("environment overrides config.json", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { previewLinks: { baseUrl: "https://a.example/f", ttlDays: 7 } },
    });
    const config = loadConfig(home, {
      env: {
        PASEO_PREVIEW_LINKS_BASE_URL: "https://b.example/f",
        PASEO_PREVIEW_LINKS_TTL_DAYS: "2",
      },
    });
    expect(config.previewLinks).toEqual({ baseUrl: "https://b.example/f", ttlMs: 2 * DAY_MS });
    expect(config.configReload?.overrideControlledPaths).toEqual(
      expect.arrayContaining(["daemon.previewLinks.baseUrl", "daemon.previewLinks.ttlDays"]),
    );
  });

  test("rejects an invalid TTL and unknown keys", async () => {
    const badTtl = await createPaseoHome({
      version: 1,
      daemon: { previewLinks: { baseUrl: "https://a.example/f", ttlDays: 0 } },
    });
    expect(() => loadConfig(badTtl, { env: {} })).toThrow();
    const unknownKey = await createPaseoHome({
      version: 1,
      daemon: { previewLinks: { baseUrl: "https://a.example/f", funnel: true } },
    });
    expect(() => loadConfig(unknownKey, { env: {} })).toThrow();
  });
});
