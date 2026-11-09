import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHADOW_TREE_COMMIT_PIN } from "./reanimated-commit-path";

// SHADOW_TREE_COMMIT_PIN relies on three facts about the installed Reanimated. If an upgrade
// changes any of them, pressables inside sliding panels, keyboard-shifted composers and sheets
// can silently stop receiving taps on Android, so this pins them to the source.

const appDir = path.resolve(__dirname, "../..");
const reanimatedProxy = readFileSync(
  require.resolve(
    "react-native-reanimated/Common/cpp/reanimated/NativeModules/ReanimatedModuleProxy.cpp",
    {
      paths: [appDir],
    },
  ),
  "utf8",
);

function androidFastPathProps(): string[] {
  const start = reanimatedProxy.indexOf("void ReanimatedModuleProxy::applySynchronousUpdates");
  const androidBlock = reanimatedProxy.slice(start, reanimatedProxy.indexOf("};", start));
  return Array.from(androidBlock.matchAll(/^\s*"([A-Za-z]+)",/gm), (match) => match[1]);
}

describe("Reanimated shadow-tree commit pin", () => {
  it("is on with the fast path enabled for Android", () => {
    const appPackage = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    expect(appPackage.reanimated.staticFeatureFlags.ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS).toBe(
      true,
    );
  });

  it("uses a property outside the Android fast-path set", () => {
    const fastPath = androidFastPathProps();
    expect(fastPath).toContain("transform");
    expect(fastPath).toContain("opacity");
    for (const key of Object.keys(SHADOW_TREE_COMMIT_PIN)) {
      expect(fastPath).not.toContain(key);
    }
  });

  it("relies on the per-frame path moving a view off the fast path as a whole", () => {
    const header = readFileSync(
      require.resolve(
        "react-native-reanimated/Common/cpp/reanimated/NativeModules/ReanimatedModuleProxy.h",
        { paths: [appDir] },
      ),
      "utf8",
    );
    expect(header).toContain(
      "void applySynchronousUpdates(UpdatesBatch &updatesBatch, bool allowPartialUpdates = false);",
    );
    expect(reanimatedProxy).toMatch(
      /if constexpr \(shouldUseSynchronousUpdatesInPerformOperations\(\)\) \{\s*applySynchronousUpdates\(updatesBatch\);/,
    );
  });
});
