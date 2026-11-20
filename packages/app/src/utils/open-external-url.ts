import * as Linking from "expo-linking";
import { isSlackAppLink } from "@getpaseo/protocol/slack-app-link";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import { openInAndroidApp } from "./open-in-android-app";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

function isAllowedWebUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Opens `url` outside Daseo. Resolves true once it was handed to the system, false when it was
 * refused (not allowed here). Rejects when the system could not open an allowed URL (for a Slack
 * app link: no Slack app takes it), so the caller can fall back.
 *
 * Allowed: http(s), and exactly the Slack app link shape `isSlackAppLink` accepts (Daseo delta
 * 135). A plain browser tab cannot tell whether a custom scheme opened anything, so there the
 * Slack app link is refused and the caller opens the https permalink instead.
 */
export async function tryOpenExternalUrl(url: string): Promise<boolean> {
  const isWebUrl = isAllowedWebUrl(url);
  const isSlackApp = !isWebUrl && isSlackAppLink(url);

  if (isWeb) {
    const opener = getDesktopHost()?.opener?.openUrl;
    if (typeof opener === "function") {
      // The Electron opener applies the same allowlist and rejects when no app takes the link.
      await opener(url);
      return true;
    }

    // Mirror the Electron opener's scheme allowlist: forge-supplied URLs
    // (check target_url, job links) reach this sink, so refuse anything that
    // is not plain http(s) instead of handing it to window.open.
    if (!isWebUrl) {
      return false;
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  if (!isWebUrl && !isSlackApp) {
    return false;
  }

  // Only web links have Android app routing; a slack:// link returns false here at once.
  if (await openInAndroidApp(url)) {
    return true;
  }

  // Rejects when no installed app handles the URL (iOS and Android both), which a Slack app link
  // relies on for its fallback.
  await Linking.openURL(url);
  return true;
}

/** `tryOpenExternalUrl` for callers that do not need to know whether the URL was refused. */
export async function openExternalUrl(url: string): Promise<void> {
  await tryOpenExternalUrl(url);
}
