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

interface UserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
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
// no client hints, so an iOS user agent gets none.
function userAgentMetadata(userAgent: string, mobile: boolean): UserAgentMetadata | undefined {
  const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  if (!version || /iPhone|iPad|iPod/.test(userAgent)) {
    return undefined;
  }
  const major = version.split(".")[0] ?? version;
  const android = /Android/.test(userAgent);
  let platform = "macOS";
  if (android) {
    platform = "Android";
  } else if (/Windows/.test(userAgent)) {
    platform = "Windows";
  }
  return {
    brands: [
      { brand: "Chromium", version: major },
      { brand: "Not_A Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version },
      { brand: "Not_A Brand", version: "24.0.0.0" },
    ],
    fullVersion: version,
    platform,
    platformVersion: android ? "10.0.0" : "",
    architecture: android ? "" : "arm",
    model: android ? (/Android [^;]+; ([^;)]+)/.exec(userAgent)?.[1] ?? "") : "",
    mobile: mobile || / Mobile /.test(userAgent),
  };
}

export async function applyDeviceEmulation(
  send: CdpCommandSender,
  emulation: DeviceEmulation | null,
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
  const metadata = userAgentMetadata(emulation.userAgent, emulation.mobile);
  await send("Emulation.setUserAgentOverride", {
    userAgent: emulation.userAgent,
    ...(metadata ? { userAgentMetadata: metadata } : {}),
  });
}
