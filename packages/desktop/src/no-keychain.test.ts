import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Daseo delta 92 (the owner, 2026-11-11: no password prompt from Daseo in any situation). The app
// is signed without a Team ID, so the macOS keychain trusts each build separately and any keychain
// read can raise a prompt after an update. No source that ships in the Mac app (desktop main, the
// daemon, the CLI) may use Electron's keychain-backed encryption, a keychain library, the keychain
// C API, or the keychain command-line tool.
const KEYCHAIN_USE = new RegExp(
  ["\\bsafeStorage\\b", "\\bkeytar\\b", "SecItem", "SecKeychain", "find-generic-password"].join(
    "|",
  ),
);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SHIPPED_SOURCE_ROOTS = ["packages/desktop/src", "packages/server/src", "packages/cli/src"];

function sourceFiles(folder: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe("no macOS keychain access", () => {
  test.each(SHIPPED_SOURCE_ROOTS)("%s never reads or writes the keychain", (root) => {
    const files = sourceFiles(path.join(REPO_ROOT, root));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .filter((file) => KEYCHAIN_USE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
