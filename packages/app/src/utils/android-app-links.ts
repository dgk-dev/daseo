/**
 * Daseo delta 85: web links that open in the site's own Android app instead of the browser.
 * Coupang answers the phone's browser with its block page, while its app shows the same
 * product. Each entry is a registrable domain: the host itself and its subdomains match.
 */
export const ANDROID_APP_LINK_PACKAGES: ReadonlyArray<{
  domain: string;
  packageName: string;
}> = [{ domain: "coupang.com", packageName: "com.coupang.mobile" }];

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

/** The Android package that should open `url`, or null when the browser should. */
export function resolveAndroidAppPackage(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  for (const entry of ANDROID_APP_LINK_PACKAGES) {
    if (host === entry.domain || host.endsWith(`.${entry.domain}`)) {
      return entry.packageName;
    }
  }
  return null;
}
