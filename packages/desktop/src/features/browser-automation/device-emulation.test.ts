import { describe, expect, test } from "vitest";
import {
  androidChromeUserAgent,
  applyDeviceEmulation,
  deviceEmulationClientHints,
  resolveDeviceEmulation,
} from "./device-emulation.js";

const MAC_HOST = { platform: "macOS", platformVersion: "26.5.1" };

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36";

describe("resolveDeviceEmulation", () => {
  test("no emulation fields means clear", () => {
    expect(resolveDeviceEmulation({ browserUserAgent: MAC_UA })).toBeNull();
  });

  test("mobile defaults to Android Chrome at DPR 3 with the browser's Chrome version", () => {
    expect(resolveDeviceEmulation({ mobile: true, browserUserAgent: MAC_UA })).toEqual({
      mobile: true,
      userAgent: androidChromeUserAgent(MAC_UA),
      deviceScaleFactor: 3,
    });
    expect(androidChromeUserAgent(MAC_UA)).toBe(
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
    );
  });

  test("a custom user agent wins over the mobile default", () => {
    expect(
      resolveDeviceEmulation({ mobile: true, userAgent: "KAKAOTALK", browserUserAgent: MAC_UA }),
    ).toMatchObject({ userAgent: "KAKAOTALK", mobile: true });
  });
});

describe("applyDeviceEmulation", () => {
  async function record(emulation: Parameters<typeof applyDeviceEmulation>[1]) {
    const sent: Array<[string, unknown]> = [];
    await applyDeviceEmulation(
      async (command, params) => {
        sent.push([command, params]);
        return {};
      },
      emulation,
      MAC_HOST,
    );
    return sent;
  }

  test("sets metrics, touch, and a user agent with matching client hints", async () => {
    const sent = await record({
      mobile: true,
      userAgent: androidChromeUserAgent(MAC_UA),
      deviceScaleFactor: 3,
    });

    expect(sent[0]).toEqual([
      "Emulation.setDeviceMetricsOverride",
      { width: 0, height: 0, deviceScaleFactor: 3, mobile: true },
    ]);
    expect(sent[1]).toEqual([
      "Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 5 },
    ]);
    expect(sent[2]?.[1]).toMatchObject({
      userAgentMetadata: {
        brands: [
          { brand: "Not-A.Brand", version: "24" },
          { brand: "Chromium", version: "146" },
        ],
        fullVersionList: [
          { brand: "Not-A.Brand", version: "24.0.0.0" },
          { brand: "Chromium", version: "146.0.0.0" },
        ],
        platform: "Android",
        platformVersion: "10.0.0",
        mobile: true,
        model: "K",
        fullVersion: "146.0.0.0",
      },
    });
  });

  test("a desktop user agent on the host platform keeps the host's platform version", async () => {
    const sent = await record({ mobile: false, userAgent: MAC_UA, deviceScaleFactor: 2 });

    expect(sent[2]?.[1]).toMatchObject({
      userAgentMetadata: { platform: "macOS", platformVersion: "26.5.1", mobile: false },
    });
  });

  test("an iPhone user agent gets no client hints, as Safari sends none", async () => {
    const sent = await record({
      mobile: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0",
      deviceScaleFactor: 3,
    });

    expect(sent[2]?.[1]).not.toHaveProperty("userAgentMetadata");
  });

  test("request client hints match the emulated userAgentData", () => {
    expect(
      deviceEmulationClientHints(
        { mobile: true, userAgent: androidChromeUserAgent(MAC_UA), deviceScaleFactor: 3 },
        MAC_HOST,
      ),
    ).toEqual({
      brands: [
        { brand: "Not-A.Brand", version: "24" },
        { brand: "Chromium", version: "146" },
      ],
      mobile: true,
      platform: "Android",
    });
    expect(
      deviceEmulationClientHints(
        {
          mobile: true,
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
          deviceScaleFactor: 3,
        },
        MAC_HOST,
      ),
    ).toBeNull();
  });

  test("clearing removes every override", async () => {
    expect((await record(null)).map(([command]) => command)).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]);
  });
});
