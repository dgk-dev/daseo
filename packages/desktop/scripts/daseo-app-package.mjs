import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

// Locales that get a localized bundle name. The raw CFBundleName must stay
// "Paseo" (Electron resolves its helper bundles through it), but Finder, the
// Dock, and the menu bar prefer the localized InfoPlist.strings value, so the
// user-visible name becomes Daseo everywhere.
const LOCALIZED_NAME_LOCALES = ["en", "ko"];

function setPlistValue(plistPath, key, value) {
  execFileSync(PLIST_BUDDY, ["-c", `Set :${key} ${value}`, plistPath]);
}

function ensurePlistValue(plistPath, key, type, value) {
  try {
    execFileSync(PLIST_BUDDY, ["-c", `Add :${key} ${type} ${value}`, plistPath], {
      stdio: "ignore",
    });
  } catch {
    setPlistValue(plistPath, key, value);
  }
}

function writeLocalizedBundleName(appPath) {
  for (const locale of LOCALIZED_NAME_LOCALES) {
    const lprojPath = path.join(appPath, "Contents", "Resources", `${locale}.lproj`);
    mkdirSync(lprojPath, { recursive: true });
    writeFileSync(
      path.join(lprojPath, "InfoPlist.strings"),
      'CFBundleName = "Daseo";\nCFBundleDisplayName = "Daseo";\n',
    );
  }
}

function assertDaseoSourceCommit(sourceCommit) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sourceCommit)) {
    throw new Error(`Invalid Daseo source commit: ${sourceCommit}`);
  }
}

export function writeDaseoDistributionMetadata(
  appPath,
  { displayVersion, buildVersion, sourceCommit },
) {
  assertDaseoSourceCommit(sourceCommit);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  mkdirSync(resourcesPath, { recursive: true });
  writeFileSync(
    path.join(resourcesPath, "daseo-distribution.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distribution: "daseo",
        updates: "signed-local-artifact",
        sourceCommit,
        displayVersion,
        macBuildVersion: buildVersion,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(path.join(resourcesPath, "app-update.yml"), { force: true });
}

export function patchDaseoMacBundleMetadata({
  appPath,
  displayVersion,
  buildVersion,
  sourceCommit,
}) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildVersion)) {
    throw new Error(`Invalid macOS build version: ${buildVersion}`);
  }
  assertDaseoSourceCommit(sourceCommit);
  const plistPath = path.join(appPath, "Contents", "Info.plist");

  setPlistValue(plistPath, "CFBundleName", "Paseo");
  setPlistValue(plistPath, "CFBundleDisplayName", "Daseo");
  setPlistValue(plistPath, "CFBundleShortVersionString", displayVersion);
  setPlistValue(plistPath, "CFBundleVersion", buildVersion);
  ensurePlistValue(plistPath, "LSHasLocalizedDisplayName", "bool", "true");
  writeDaseoDistributionMetadata(appPath, { displayVersion, buildVersion, sourceCommit });
  writeLocalizedBundleName(appPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [appPath, displayVersion, buildVersion, sourceCommit] = process.argv.slice(2);
  if (!appPath || !displayVersion || !buildVersion || !sourceCommit) {
    throw new Error(
      "Usage: daseo-app-package.mjs <app-path> <display-version> <mac-build-version> <source-commit>",
    );
  }
  patchDaseoMacBundleMetadata({ appPath, displayVersion, buildVersion, sourceCommit });
}
