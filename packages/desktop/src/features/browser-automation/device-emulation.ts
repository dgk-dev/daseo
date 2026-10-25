import {
  chromiumBrandVersionList,
  type ClientHintMetadata,
  type UserAgentBrandVersion,
} from "../browser-profile.js";
import type { CdpCommandSender } from "./cdp-session-queue.js";

// browser_resize changed only the webview size, so a 390px "mobile" check still
// ran with a desktop user agent, a mouse pointer, and DPR 2: UA-based mobile
// redirects, `(hover: none)` and `(pointer: coarse)` rules, and touch handlers
// never engaged, and in-app browser checks had to be faked outside the browser.
// These are DevTools' device-mode overrides, applied per tab over CDP.

export interface DeviceEmulation {
  mobile: boolean;
  userAgent: string;
  deviceScaleFactor: number;
}

const DEFAULT_MOBILE_SCALE_FACTOR = 3;

/** The machine the browser runs on, as `navigator.userAgentData` reports it without emulation. */
export interface DeviceEmulationHost {
  platform: string;
  platformVersion: string;
}

interface UserAgentMetadata {
  brands: UserAgentBrandVersion[];
  fullVersionList: UserAgentBrandVersion[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

/** Null clears the overrides; otherwise the emulation the tab ends up with. */
export function resolveDeviceEmulation(input: {
  mobile?: boolean;
  userAgent?: string;
  deviceScaleFactor?: number;
  browserUserAgent: string;
}): DeviceEmulation | null {
  if (!input.mobile && !input.userAgent && input.deviceScaleFactor === undefined) {
    return null;
  }
  const mobile = input.mobile === true;
  return {
    mobile,
    userAgent:
      input.userAgent ??
      (mobile ? androidChromeUserAgent(input.browserUserAgent) : input.browserUserAgent),
    deviceScaleFactor: input.deviceScaleFactor ?? (mobile ? DEFAULT_MOBILE_SCALE_FACTOR : 1),
  };
}

/** Chrome's reduced Android user agent with the browser's own Chrome version. */
export function androidChromeUserAgent(browserUserAgent: string): string {
  const version = /Chrome\/([\d.]+)/.exec(browserUserAgent)?.[1] ?? "146.0.0.0";
  const major = version.split(".")[0] ?? "146";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

// Client hints have to agree with the user agent string or sites that read
// navigator.userAgentData (and Sec-CH-UA-Mobile) still see a Mac. Safari sends
// no client hints, so an iOS user agent gets none. Brands use the browser's own
// GREASE brand, so emulation changes the platform and nothing else; a desktop
// user agent on the host's own platform keeps the host's real platform version.
function userAgentMetadata(
  userAgent: string,
  mobile: boolean,
  host: DeviceEmulationHost,
): UserAgentMetadata | undefined {
  const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  if (!version || /iPhone|iPad|iPod/.test(userAgent)) {
    return undefined;
  }
  const android = /Android/.test(userAgent);
  let platform = "macOS";
  if (android) {
    platform = "Android";
  } else if (/Windows/.test(userAgent)) {
    platform = "Windows";
  }
  let platformVersion = "";
  if (android) {
    platformVersion = "10.0.0";
  } else if (platform === host.platform) {
    platformVersion = host.platformVersion;
  }
  return {
    brands: chromiumBrandVersionList(version, "major"),
    fullVersionList: chromiumBrandVersionList(version, "full"),
    fullVersion: version,
    platform,
    platformVersion,
    architecture: android ? "" : "arm",
    model: android ? (/Android [^;]+; ([^;)]+)/.exec(userAgent)?.[1] ?? "") : "",
    mobile: mobile || / Mobile /.test(userAgent),
  };
}

/**
 * The client hints an emulating tab's requests carry: what its `navigator.userAgentData` reports,
 * or null when the emulated user agent sends none.
 */
export function deviceEmulationClientHints(
  emulation: DeviceEmulation,
  host: DeviceEmulationHost,
): ClientHintMetadata | null {
  const metadata = userAgentMetadata(emulation.userAgent, emulation.mobile, host);
  return metadata
    ? { brands: metadata.brands, mobile: metadata.mobile, platform: metadata.platform }
    : null;
}

export async function applyDeviceEmulation(
  send: CdpCommandSender,
  emulation: DeviceEmulation | null,
  host: DeviceEmulationHost,
): Promise<void> {
  if (!emulation) {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    // An empty user agent removes the override, client hints included.
    await send("Emulation.setUserAgentOverride", { userAgent: "" });
    return;
  }
  // Zero width and height keep the webview's own size, which browser_resize already set.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 0,
    height: 0,
    deviceScaleFactor: emulation.deviceScaleFactor,
    mobile: emulation.mobile,
  });
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: emulation.mobile,
    ...(emulation.mobile ? { maxTouchPoints: 5 } : {}),
  });
  const metadata = userAgentMetadata(emulation.userAgent, emulation.mobile, host);
  await send("Emulation.setUserAgentOverride", {
    userAgent: emulation.userAgent,
    ...(metadata ? { userAgentMetadata: metadata } : {}),
  });
}
