import { Platform } from "react-native";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import * as Sharing from "expo-sharing";

const ANDROID_FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Daseo delta 62: a file the phone downloaded opens in whatever app handles it, outside Daseo.
 * Android gets a plain "view" intent on a content URI (the picker if several apps qualify);
 * when nothing handles the type, and on iOS, the share sheet offers the same apps.
 */
export async function openDownloadedFile(input: {
  uri: string;
  mimeType: string | null;
  dialogTitle: string;
}): Promise<void> {
  if (Platform.OS === "android") {
    try {
      const contentUri = await LegacyFileSystem.getContentUriAsync(input.uri);
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: contentUri,
        flags: ANDROID_FLAG_GRANT_READ_URI_PERMISSION,
        ...(input.mimeType ? { type: input.mimeType } : {}),
      });
      return;
    } catch {
      // No viewer for this type, or the launcher refused: fall through to the share sheet.
    }
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(input.uri, {
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      dialogTitle: input.dialogTitle,
    });
  }
}
