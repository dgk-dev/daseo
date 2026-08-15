import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

export function patchDaseoMacBundleMetadata({ appPath, displayVersion }) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");

  setPlistValue(plistPath, "CFBundleName", "Paseo");
  setPlistValue(plistPath, "CFBundleDisplayName", "Daseo");
  setPlistValue(plistPath, "CFBundleShortVersionString", displayVersion);
  setPlistValue(plistPath, "CFBundleVersion", displayVersion);
  ensurePlistValue(plistPath, "LSHasLocalizedDisplayName", "bool", "true");
  writeLocalizedBundleName(appPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [appPath, displayVersion] = process.argv.slice(2);
  if (!appPath || !displayVersion) {
    throw new Error("Usage: daseo-app-package.mjs <app-path> <display-version>");
  }
  patchDaseoMacBundleMetadata({ appPath, displayVersion });
}
