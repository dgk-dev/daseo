import { openExternalUrl, tryOpenExternalUrl } from "./open-external-url";

/**
 * Daseo delta 135: open a sent Slack message in the Slack app (Mac desktop app, phone app), and
 * the https permalink in the browser when there is no app link, the platform cannot open one, or
 * no Slack app takes it.
 */
export async function openSlackMessage(links: {
  appLink: string | null;
  permalink: string | null;
}): Promise<void> {
  if (links.appLink) {
    try {
      if (await tryOpenExternalUrl(links.appLink)) {
        return;
      }
    } catch {
      // No Slack app for the link: the permalink below.
    }
  }
  if (links.permalink) {
    await openExternalUrl(links.permalink);
  }
}
