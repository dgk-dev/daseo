import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

function setPlistValue(plistPath, key, value) {
  execFileSync(PLIST_BUDDY, ["-c", `Set :${key} ${value}`, plistPath]);
}

export function patchDaseoMacBundleMetadata({ appPath, displayVersion }) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");

  setPlistValue(plistPath, "CFBundleName", "Paseo");
  setPlistValue(plistPath, "CFBundleDisplayName", "Daseo");
  setPlistValue(plistPath, "CFBundleShortVersionString", displayVersion);
  setPlistValue(plistPath, "CFBundleVersion", displayVersion);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [appPath, displayVersion] = process.argv.slice(2);
  if (!appPath || !displayVersion) {
    throw new Error("Usage: daseo-app-package.mjs <app-path> <display-version>");
  }
  patchDaseoMacBundleMetadata({ appPath, displayVersion });
}
