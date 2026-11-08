import { describe, expect, it } from "vitest";
import { resolveAndroidAppPackage } from "./android-app-links";

describe("resolveAndroidAppPackage", () => {
  it.each([
    "https://coupang.com/vp/products/8556671403",
    "https://www.coupang.com/vp/products/8556671403",
    "https://m.coupang.com/vm/products/8556671403",
    "https://link.coupang.com/a/abc123",
    "https://pages.coupang.com/p/12345",
  ])("sends %s to the Coupang app", (url) => {
    expect(resolveAndroidAppPackage(url)).toBe("com.coupang.mobile");
  });

  it("matches the host case-insensitively and with a trailing dot", () => {
    expect(resolveAndroidAppPackage("https://WWW.Coupang.COM/vp/products/1")).toBe(
      "com.coupang.mobile",
    );
    expect(resolveAndroidAppPackage("https://www.coupang.com./vp/products/1")).toBe(
      "com.coupang.mobile",
    );
  });

  it("matches http as well as https", () => {
    expect(resolveAndroidAppPackage("http://www.coupang.com/vp/products/1")).toBe(
      "com.coupang.mobile",
    );
  });

  it("keeps matching with a port, query, and fragment", () => {
    expect(
      resolveAndroidAppPackage(
        "https://www.coupang.com:443/vp/products/8556671403?itemId=1&vendorItemId=2#sdpReview",
      ),
    ).toBe("com.coupang.mobile");
  });

  it.each([
    "https://coupang.com.evil.net/vp/products/1",
    "https://notcoupang.com/vp/products/1",
    "https://www.coupang.co/vp/products/1",
    "https://evil.net/?next=https://www.coupang.com/vp/products/1",
    "https://www.coupang.com@evil.net/vp/products/1",
    "https://www.danawa.com/",
  ])("leaves %s to the browser", (url) => {
    expect(resolveAndroidAppPackage(url)).toBeNull();
  });

  it.each(["coupang://vp/products/1", "ftp://www.coupang.com/", "not a url", ""])(
    "returns null for %j",
    (url) => {
      expect(resolveAndroidAppPackage(url)).toBeNull();
    },
  );
});
