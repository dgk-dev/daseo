import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewLinkStore } from "./link-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("PreviewLinkStore", () => {
  let paseoHome: string;
  let now: number;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "preview-links-"));
    now = Date.parse("2026-11-01T00:00:00.000Z");
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  function createStore(): PreviewLinkStore {
    return new PreviewLinkStore({ paseoHome, now: () => now });
  }

  it("issues a reusable 128-bit token that survives a restart", async () => {
    const issued = createStore().issue({
      absolutePath: "/tmp/report.md",
      fileName: "report.md",
      ttlMs: 30 * DAY_MS,
    });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(issued.expiresAt).toBe("2026-12-01T00:00:00.000Z");

    const reopened = createStore();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lookup = reopened.lookup(issued.token);
      expect(lookup.status).toBe("found");
      expect(lookup.status === "found" ? lookup.entry.absolutePath : null).toBe("/tmp/report.md");
    }
    expect(reopened.lookup("A".repeat(22)).status).toBe("missing");
  });

  it("writes only a hash of the token, in a private file", async () => {
    const issued = createStore().issue({
      absolutePath: "/tmp/a.pdf",
      fileName: "a.pdf",
      ttlMs: DAY_MS,
    });
    const filePath = path.join(paseoHome, "preview-links.json");
    const raw = await readFile(filePath, "utf8");

    expect(raw).not.toContain(issued.token);
    expect(JSON.parse(raw)).toMatchObject({ version: 1, links: [{ fileName: "a.pdf" }] });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports an expired link and drops it on load and on the next issue", async () => {
    const store = createStore();
    const short = store.issue({ absolutePath: "/tmp/a.txt", fileName: "a.txt", ttlMs: DAY_MS });
    const long = store.issue({ absolutePath: "/tmp/b.txt", fileName: "b.txt", ttlMs: 10 * DAY_MS });

    now += 2 * DAY_MS;
    expect(store.lookup(short.token).status).toBe("expired");
    expect(store.lookup(long.token).status).toBe("found");

    const reopened = createStore();
    expect(reopened.lookup(short.token).status).toBe("missing");
    const persisted = JSON.parse(
      await readFile(path.join(paseoHome, "preview-links.json"), "utf8"),
    ) as { links: Array<{ fileName: string }> };
    expect(persisted.links.map((link) => link.fileName)).toEqual(["b.txt"]);

    store.issue({ absolutePath: "/tmp/c.txt", fileName: "c.txt", ttlMs: DAY_MS });
    const afterIssue = JSON.parse(
      await readFile(path.join(paseoHome, "preview-links.json"), "utf8"),
    ) as { links: Array<{ fileName: string }> };
    expect(afterIssue.links.map((link) => link.fileName).sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("copies an unreadable store aside and starts empty", async () => {
    const filePath = path.join(paseoHome, "preview-links.json");
    await writeFile(filePath, "{ not json", "utf8");

    const store = createStore();
    expect(store.lookup("A".repeat(22)).status).toBe("missing");
    const entries = await readdir(paseoHome);
    expect(entries.some((entry) => entry.startsWith("preview-links.json.corrupt-"))).toBe(true);

    const issued = store.issue({ absolutePath: "/tmp/a.txt", fileName: "a.txt", ttlMs: DAY_MS });
    expect(createStore().lookup(issued.token).status).toBe("found");
  });
});
