const { withAndroidManifest } = require("expo/config-plugins");

// Daseo: folding or unfolding a Galaxy Fold changes the smallest screen width. Expo's
// template omits `smallestScreenSize` (React Native's own template has it), so Android
// destroyed and recreated MainActivity on every fold, which broke Activity-result based
// pickers until the process restarted. Handling the change in place keeps the Activity.
const REQUIRED_CONFIG_CHANGES = ["smallestScreenSize"];

function withAndroidFoldConfigChanges(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (activity) => activity.$["android:name"] === ".MainActivity",
    );
    if (!mainActivity) {
      throw new Error("Could not find .MainActivity to extend android:configChanges");
    }

    const current = (mainActivity.$["android:configChanges"] ?? "")
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const change of REQUIRED_CONFIG_CHANGES) {
      if (!current.includes(change)) current.push(change);
    }
    mainActivity.$["android:configChanges"] = current.join("|");
    return modConfig;
  });
}

module.exports = withAndroidFoldConfigChanges;
