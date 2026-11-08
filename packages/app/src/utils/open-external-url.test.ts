import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: { OS: "android" as string },
  openURL: vi.fn<(url: string) => Promise<void>>(),
  openUrlInPackage: vi.fn<(url: string, packageName: string) => Promise<boolean>>(),
}));

vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null }));
vi.mock("expo-linking", () => ({ openURL: mocks.openURL }));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) =>
    name === "DaseoAppLinks" ? { openUrlInPackage: mocks.openUrlInPackage } : null,
}));

const { openExternalUrl } = await import("./open-external-url");

const COUPANG_URL = "https://www.coupang.com/vp/products/8556671403?itemId=1&vendorItemId=2";
const COUPANG_SHARE_URL =
  "https://link.coupang.com/re/CSHARESDP?pageKey=8556671403&itemId=1&vendorItemId=2";

describe("openExternalUrl on native", () => {
  beforeEach(() => {
    mocks.platform.OS = "android";
    mocks.openURL.mockReset().mockResolvedValue(undefined);
    mocks.openUrlInPackage.mockReset();
  });

  it("opens a Coupang product link in the Coupang app as its share link", async () => {
    mocks.openUrlInPackage.mockResolvedValue(true);

    await openExternalUrl(COUPANG_URL);

    expect(mocks.openUrlInPackage).toHaveBeenCalledTimes(1);
    expect(mocks.openUrlInPackage).toHaveBeenCalledWith(COUPANG_SHARE_URL, "com.coupang.mobile");
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  it("falls back to the browser once with the original link when the app takes no such link", async () => {
    mocks.openUrlInPackage.mockResolvedValue(false);

    await openExternalUrl(COUPANG_URL);

    expect(mocks.openUrlInPackage).toHaveBeenCalledTimes(1);
    expect(mocks.openUrlInPackage).toHaveBeenCalledWith(COUPANG_SHARE_URL, "com.coupang.mobile");
    expect(mocks.openURL).toHaveBeenCalledTimes(1);
    expect(mocks.openURL).toHaveBeenCalledWith(COUPANG_URL);
  });

  it("hands other Coupang links to the app unchanged", async () => {
    const searchUrl = "https://www.coupang.com/np/search?q=tv";
    mocks.openUrlInPackage.mockResolvedValue(true);

    await openExternalUrl(searchUrl);

    expect(mocks.openUrlInPackage).toHaveBeenCalledWith(searchUrl, "com.coupang.mobile");
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  it("falls back to the browser once when the native call throws", async () => {
    mocks.openUrlInPackage.mockRejectedValue(new Error("ReactContextLost"));

    await openExternalUrl(COUPANG_URL);

    expect(mocks.openUrlInPackage).toHaveBeenCalledTimes(1);
    expect(mocks.openURL).toHaveBeenCalledTimes(1);
    expect(mocks.openURL).toHaveBeenCalledWith(COUPANG_URL);
  });

  it("sends other links straight to the browser", async () => {
    await openExternalUrl("https://www.danawa.com/");

    expect(mocks.openUrlInPackage).not.toHaveBeenCalled();
    expect(mocks.openURL).toHaveBeenCalledWith("https://www.danawa.com/");
  });

  it("keeps iOS on the browser path for Coupang links", async () => {
    mocks.platform.OS = "ios";

    await openExternalUrl(COUPANG_URL);

    expect(mocks.openUrlInPackage).not.toHaveBeenCalled();
    expect(mocks.openURL).toHaveBeenCalledTimes(1);
    expect(mocks.openURL).toHaveBeenCalledWith(COUPANG_URL);
  });

  it("still refuses non-web schemes before any app routing", async () => {
    await openExternalUrl("javascript:alert(1)");

    expect(mocks.openUrlInPackage).not.toHaveBeenCalled();
    expect(mocks.openURL).not.toHaveBeenCalled();
  });
});
