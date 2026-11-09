import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveNamedPath } from "./path-resolve.js";

let root: string;

async function touch(relativePath: string): Promise<string> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "x");
  return absolutePath;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "named-path-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveNamedPath", () => {
  test("an existing exact candidate wins without a search, with its kind", async () => {
    const file = await touch("docs/report.md");
    await touch("other/docs/report.md");

    await expect(
      resolveNamedPath({ cwd: root, candidates: ["docs/report.md"], suffix: "docs/report.md" }),
    ).resolves.toEqual({ matches: [{ path: file, kind: "file" }], complete: true });
    await expect(resolveNamedPath({ cwd: root, candidates: ["docs"] })).resolves.toEqual({
      matches: [{ path: path.join(root, "docs"), kind: "directory" }],
      complete: true,
    });
  });

  test("finds the one file an elided path names, inside hidden folders too", async () => {
    const file = await touch(".pi/agent/plans/research/2026-11-09-report.md");

    await expect(
      resolveNamedPath({ cwd: root, candidates: [], suffix: "research/2026-11-09-report.md" }),
    ).resolves.toEqual({ matches: [{ path: file, kind: "file" }], complete: true });
  });

  test("reports two matches when the name is ambiguous", async () => {
    const first = await touch("apps/office/src/route.ts");
    const second = await touch("apps/visual/src/route.ts");

    const result = await resolveNamedPath({ cwd: root, candidates: [], suffix: "src/route.ts" });

    expect(result.complete).toBe(true);
    expect(result.matches.map((match) => match.path).sort()).toEqual([first, second].sort());
  });

  test("narrows a suffix search to matches under the named head", async () => {
    await touch("apps/office/lib/schema.ts");
    const mktg = await touch("apps/mktg/src/lib/schema.ts");

    await expect(
      resolveNamedPath({ cwd: root, candidates: [], suffix: "schema.ts", contains: "apps/mktg" }),
    ).resolves.toEqual({ matches: [{ path: mktg, kind: "file" }], complete: true });
  });

  test("skips package stores and the daemon's own heavy folders", async () => {
    await touch("node_modules/pkg/report.md");
    await touch("store/timelines/a/report.md");
    const kept = await touch("notes/report.md");

    await expect(
      resolveNamedPath({
        cwd: root,
        candidates: [],
        suffix: "report.md",
        skipPaths: [path.join(root, "store/timelines")],
      }),
    ).resolves.toEqual({ matches: [{ path: kept, kind: "file" }], complete: true });
  });

  test("never walks out of the workspace through `..` or a symlink", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "named-path-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "x");
      await symlink(outside, path.join(root, "link"));

      await expect(
        resolveNamedPath({ cwd: root, candidates: [], suffix: "../secret.md" }),
      ).resolves.toEqual({ matches: [], complete: true });
      await expect(
        resolveNamedPath({ cwd: root, candidates: [], suffix: "secret.md" }),
      ).resolves.toEqual({ matches: [], complete: true });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("stops at its time budget and says the search is incomplete", async () => {
    await touch("a/b/c/report.md");
    let clock = 0;

    await expect(
      resolveNamedPath({
        cwd: root,
        candidates: [],
        suffix: "report.md",
        budgetMs: 1,
        now: () => (clock += 5),
      }),
    ).resolves.toEqual({ matches: [], complete: false });
  });
});
