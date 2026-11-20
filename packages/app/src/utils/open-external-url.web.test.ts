import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopOpenUrl: null as null | ((url: string) => Promise<void>),
  windowOpen: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () =>
    mocks.desktopOpenUrl ? { opener: { openUrl: mocks.desktopOpenUrl } } : null,
}));
vi.mock("expo-linking", () => ({ openURL: vi.fn() }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

const { tryOpenExternalUrl } = await import("./open-external-url");

const APP_LINK = "slack://channel?team=T02004LSA0L&id=D0AQ557U7U2&message=1795129200.272279";

describe("openExternalUrl on web (delta 135 Slack app links)", () => {
  beforeEach(() => {
    mocks.desktopOpenUrl = null;
    mocks.windowOpen.mockReset();
    vi.stubGlobal("window", { open: mocks.windowOpen });
  });

  it("hands a Slack app link to the desktop opener, which rejects when no app takes it", async () => {
    const opener = vi.fn(async (_url: string) => undefined);
    mocks.desktopOpenUrl = opener;
    await expect(tryOpenExternalUrl(APP_LINK)).resolves.toBe(true);
    expect(opener).toHaveBeenCalledWith(APP_LINK);

    opener.mockRejectedValueOnce(new Error("no handler"));
    await expect(tryOpenExternalUrl(APP_LINK)).rejects.toThrow("no handler");
  });

  it("refuses a Slack app link in a plain browser tab, which cannot tell whether it opened", async () => {
    await expect(tryOpenExternalUrl(APP_LINK)).resolves.toBe(false);
    expect(mocks.windowOpen).not.toHaveBeenCalled();

    await expect(tryOpenExternalUrl("https://dfcorp.slack.com/archives/D1/p1")).resolves.toBe(true);
    expect(mocks.windowOpen).toHaveBeenCalledWith(
      "https://dfcorp.slack.com/archives/D1/p1",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
