import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { preserveUnreadableFile, preserveUnreadableFileSync } from "./atomic-file.js";

const MODE_MASK = 0o777;
const directories: string[] = [];

afterEach(() => {
  // Innermost first, so a directory a failed test left read-only is writable again before its
  // parent is removed.
  const created = directories.splice(0);
  for (const directory of created.toReversed()) {
    chmodSync(directory, 0o700);
  }
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-atomic-file-"));
  directories.push(directory);
  return directory;
}

function clock(iso: string): () => Date {
  return () => new Date(iso);
}

function corruptBackups(directory: string, basename: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.startsWith(`${basename}.corrupt-`))
    .sort();
}

const variants = [
  { name: "async", preserve: preserveUnreadableFile },
  {
    name: "sync",
    preserve: async (...args: Parameters<typeof preserveUnreadableFileSync>) =>
      preserveUnreadableFileSync(...args),
  },
];

describe.each(variants)("preserveUnreadableFile ($name)", ({ preserve }) => {
  test("copies the original bytes next to the file and leaves the original in place", async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, "workspaces.json");
    const garbage = Buffer.from([0x7b, 0x22, 0x00, 0xff, 0x0a, 0x5b]);
    writeFileSync(filePath, garbage);

    const backupPath = await preserve(filePath, { now: clock("2026-10-15T09:30:12.123Z") });

    expect(backupPath).toBe(path.join(directory, "workspaces.json.corrupt-20261015T093012-123Z"));
    expect(readFileSync(backupPath!)).toEqual(garbage);
    expect(readFileSync(filePath)).toEqual(garbage);
  });

  test.skipIf(process.platform === "win32")("keeps the source file mode", async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, "push-tokens.json");
    writeFileSync(filePath, "not json");
    chmodSync(filePath, 0o600);

    const backupPath = await preserve(filePath);

    expect(statSync(backupPath!).mode & MODE_MASK).toBe(0o600);
  });

  test("keeps only the three newest backups of the same file", async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, "projects.json");
    const unrelated = path.join(directory, "workspaces.json.corrupt-20260101T000000-000Z");
    writeFileSync(unrelated, "other store");
    for (const [index, iso] of [
      "2026-10-15T09:00:00.000Z",
      "2026-10-15T09:00:01.000Z",
      "2026-10-15T09:00:02.000Z",
      "2026-10-15T09:00:03.000Z",
      "2026-10-15T09:00:04.000Z",
    ].entries()) {
      writeFileSync(filePath, `garbage ${index}`);
      await preserve(filePath, { now: clock(iso) });
    }

    const kept = corruptBackups(directory, "projects.json");
    expect(kept).toEqual([
      "projects.json.corrupt-20261015T090002-000Z",
      "projects.json.corrupt-20261015T090003-000Z",
      "projects.json.corrupt-20261015T090004-000Z",
    ]);
    expect(readFileSync(path.join(directory, kept[2]!), "utf8")).toBe("garbage 4");
    expect(readFileSync(unrelated, "utf8")).toBe("other store");
  });

  test("returns null when the file does not exist", async () => {
    const directory = createDirectory();

    await expect(preserve(path.join(directory, "missing.json"))).resolves.toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns null instead of throwing when the directory is not writable",
    async () => {
      const directory = createDirectory();
      const storeDirectory = path.join(directory, "store");
      mkdirSync(storeDirectory);
      directories.push(storeDirectory);
      const filePath = path.join(storeDirectory, "receipts.json");
      writeFileSync(filePath, "not json");
      chmodSync(storeDirectory, 0o500);

      await expect(preserve(filePath)).resolves.toBeNull();
      chmodSync(storeDirectory, 0o700);
      expect(readdirSync(storeDirectory)).toEqual(["receipts.json"]);
    },
  );
});
