import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { resolveAndroidAppPackage } from "./android-app-links";

// Daseo delta 85. `expo-intent-launcher` cannot do this: it sets the package only together with
// an activity class name, and it waits on `startActivityForResult` until the opened app returns.
interface DaseoAppLinksModule {
  /** Resolves true once the app was started, false when it has no activity for the link. */
  openUrlInPackage(url: string, packageName: string): Promise<boolean>;
}

const appLinksModule = requireOptionalNativeModule<DaseoAppLinksModule>("DaseoAppLinks");

/**
 * Opens `url` in the Android app registered for its site (see `ANDROID_APP_LINK_PACKAGES`).
 * Returns false, having opened nothing, when the link is not for such an app, the app is not
 * installed or does not take this link, or the platform is not Android; the caller then opens
 * the link the usual way.
 */
export async function openInAndroidApp(url: string): Promise<boolean> {
  if (Platform.OS !== "android" || !appLinksModule) {
    return false;
  }
  const packageName = resolveAndroidAppPackage(url);
  if (!packageName) {
    return false;
  }
  try {
    return await appLinksModule.openUrlInPackage(url, packageName);
  } catch {
    return false;
  }
}
