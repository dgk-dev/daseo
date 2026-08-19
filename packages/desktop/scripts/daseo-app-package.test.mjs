import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  patchDaseoMacBundleMetadata,
  writeDaseoDistributionMetadata,
} from "./daseo-app-package.mjs";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const tempRoots = [];

function readPlistValue(plistPath, key) {
  return execFileSync(PLIST_BUDDY, ["-c", `Print :${key}`, plistPath], {
    encoding: "utf8",
  }).trim();
}

function createPaseoAppFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "daseo-package-test-"));
  tempRoots.push(root);
  const appPath = path.join(root, "Daseo.app");
  const contentsPath = path.join(appPath, "Contents");
  mkdirSync(contentsPath, { recursive: true });
  const plistPath = path.join(contentsPath, "Info.plist");
  const resourcesPath = path.join(contentsPath, "Resources");
  mkdirSync(resourcesPath, { recursive: true });
  writeFileSync(path.join(resourcesPath, "app-update.yml"), "owner: getpaseo\nrepo: paseo\n");
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Paseo</string>
<key>CFBundleDisplayName</key><string>Paseo</string>
<key>CFBundleExecutable</key><string>Paseo</string>
<key>CFBundleShortVersionString</key><string>0.4.0-beta.2</string>
<key>CFBundleVersion</key><string>0.4.0-beta.2</string>
</dict></plist>
`,
  );
  return { appPath, plistPath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Daseo distribution metadata", () => {
  test("marks the fork and removes the upstream update feed on every platform", () => {
    const { appPath } = createPaseoAppFixture();

    writeDaseoDistributionMetadata(appPath);

    expect(
      JSON.parse(
        readFileSync(
          path.join(appPath, "Contents", "Resources", "daseo-distribution.json"),
          "utf8",
        ),
      ),
    ).toEqual({ distribution: "daseo", updates: "signed-local-artifact" });
    expect(existsSync(path.join(appPath, "Contents", "Resources", "app-update.yml"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("Daseo macOS package metadata", () => {
  test("keeps Paseo's Electron identity while separating product and build versions", () => {
    const { appPath, plistPath } = createPaseoAppFixture();

    patchDaseoMacBundleMetadata({
      appPath,
      displayVersion: "0.4.1",
      buildVersion: "4001",
    });

    expect(readPlistValue(plistPath, "CFBundleName")).toBe("Paseo");
    expect(readPlistValue(plistPath, "CFBundleDisplayName")).toBe("Daseo");
    expect(readPlistValue(plistPath, "CFBundleExecutable")).toBe("Paseo");
    expect(readPlistValue(plistPath, "CFBundleShortVersionString")).toBe("0.4.1");
    expect(readPlistValue(plistPath, "CFBundleVersion")).toBe("4001");
    expect(
      JSON.parse(
        readFileSync(
          path.join(appPath, "Contents", "Resources", "daseo-distribution.json"),
          "utf8",
        ),
      ),
    ).toEqual({ distribution: "daseo", updates: "signed-local-artifact" });
    expect(existsSync(path.join(appPath, "Contents", "Resources", "app-update.yml"))).toBe(false);
  });

  test("applies the safe metadata contract from the packaging command", () => {
    const { appPath, plistPath } = createPaseoAppFixture();
    const scriptPath = fileURLToPath(new URL("./daseo-app-package.mjs", import.meta.url));

    execFileSync(process.execPath, [scriptPath, appPath, "0.4.1", "4001"]);

    expect(readPlistValue(plistPath, "CFBundleName")).toBe("Paseo");
    expect(readPlistValue(plistPath, "CFBundleDisplayName")).toBe("Daseo");
    expect(readPlistValue(plistPath, "CFBundleShortVersionString")).toBe("0.4.1");
    expect(readPlistValue(plistPath, "CFBundleVersion")).toBe("4001");
  });

  test("rejects a display version reused as the macOS build number", () => {
    const { appPath } = createPaseoAppFixture();

    expect(() =>
      patchDaseoMacBundleMetadata({
        appPath,
        displayVersion: "0.4.1",
        buildVersion: "0.4.1-local.1",
      }),
    ).toThrow("Invalid macOS build version");
  });

  test("writes localized bundle names and marks the display name localized", () => {
    const { appPath, plistPath } = createPaseoAppFixture();
    patchDaseoMacBundleMetadata({
      appPath,
      displayVersion: "0.4.1",
      buildVersion: "4001",
    });
    for (const locale of ["en", "ko"]) {
      const strings = path.join(
        appPath,
        "Contents",
        "Resources",
        `${locale}.lproj`,
        "InfoPlist.strings",
      );
      const content = execFileSync("/bin/cat", [strings], { encoding: "utf8" });
      expect(content).toContain('CFBundleName = "Daseo";');
      expect(content).toContain('CFBundleDisplayName = "Daseo";');
    }
    expect(readPlistValue(plistPath, "LSHasLocalizedDisplayName")).toBe("true");
    expect(readPlistValue(plistPath, "CFBundleName")).toBe("Paseo");
  });
});
