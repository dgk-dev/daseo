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

function parseWebUrl(url: string): { parsed: URL; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }
  return { parsed, host: parsed.hostname.toLowerCase().replace(/\.$/, "") };
}

/** The Android package that should open `url`, or null when the browser should. */
export function resolveAndroidAppPackage(url: string): string | null {
  const web = parseWebUrl(url);
  if (!web) {
    return null;
  }
  const { host } = web;
  for (const entry of ANDROID_APP_LINK_PACKAGES) {
    if (host === entry.domain || host.endsWith(`.${entry.domain}`)) {
      return entry.packageName;
    }
  }
  return null;
}

const COUPANG_PRODUCT_PATHS: ReadonlyArray<{ hosts: ReadonlySet<string>; path: RegExp }> = [
  { hosts: new Set(["coupang.com", "www.coupang.com"]), path: /^\/vp\/products\/(\d+)\/?$/ },
  { hosts: new Set(["m.coupang.com"]), path: /^\/vm\/products\/(\d+)\/?$/ },
];
const COUPANG_OPTION_PARAMS = ["itemId", "vendorItemId"] as const;
const DIGITS = /^\d+$/;

/**
 * The first value of `name` in a raw `?a=1&b=2` query when it is all digits, else null. Reads the
 * raw string because React Native's `URLSearchParams` polyfill throws on malformed
 * percent-encoding; an all-digit value needs no decoding.
 */
function readDigitParam(search: string, name: string): string | null {
  for (const pair of search.replace(/^\?/, "").split("&")) {
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    if (key === name) {
      const value = separator === -1 ? "" : pair.slice(separator + 1);
      return DIGITS.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * The URL to hand to the site's Android app for `url`; `url` itself when no rule applies.
 * The Coupang app's link filters take only `link.coupang.com` (its verified App Link host), not
 * www/m product pages, so a product page becomes the app's own share-link form. `itemId` and
 * `vendorItemId` carry over because they select the product option. Use the result only for the
 * app attempt: the browser fallback keeps the original URL.
 */
export function toAndroidAppUrl(url: string): string {
  const web = parseWebUrl(url);
  if (!web) {
    return url;
  }
  const { parsed, host } = web;
  for (const rule of COUPANG_PRODUCT_PATHS) {
    if (!rule.hosts.has(host)) {
      continue;
    }
    const productId = rule.path.exec(parsed.pathname)?.[1];
    if (!productId) {
      return url;
    }
    let shareUrl = `https://link.coupang.com/re/CSHARESDP?pageKey=${productId}`;
    for (const name of COUPANG_OPTION_PARAMS) {
      const value = readDigitParam(parsed.search, name);
      if (value) {
        shareUrl += `&${name}=${value}`;
      }
    }
    return shareUrl;
  }
  return url;
}
