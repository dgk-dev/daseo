import { describe, expect, it } from "vitest";
import { resolveAndroidAppPackage, toAndroidAppUrl } from "./android-app-links";

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

describe("toAndroidAppUrl", () => {
  const SHARE = "https://link.coupang.com/re/CSHARESDP?pageKey=8556671403";

  it.each([
    "https://www.coupang.com/vp/products/8556671403",
    "https://coupang.com/vp/products/8556671403",
    "https://m.coupang.com/vm/products/8556671403",
    "https://www.coupang.com/vp/products/8556671403/",
    "https://m.coupang.com/vm/products/8556671403/",
    "http://www.coupang.com/vp/products/8556671403",
    "https://WWW.Coupang.COM./vp/products/8556671403",
    "https://www.coupang.com/vp/products/8556671403#sdpReview",
    "https://www.coupang.com/vp/products/8556671403?q=%EB%83%89%EC%9E%A5%EA%B3%A0&rank=3",
  ])("rewrites the product page %s to the share link", (url) => {
    expect(toAndroidAppUrl(url)).toBe(SHARE);
  });

  it("carries itemId and vendorItemId from www and m product pages", () => {
    expect(
      toAndroidAppUrl(
        "https://www.coupang.com/vp/products/8556671403?itemId=1&vendorItemId=2&sourceType=srp#x",
      ),
    ).toBe(`${SHARE}&itemId=1&vendorItemId=2`);
    expect(
      toAndroidAppUrl("https://m.coupang.com/vm/products/8556671403/?vendorItemId=2&itemId=1"),
    ).toBe(`${SHARE}&itemId=1&vendorItemId=2`);
  });

  it("carries only the option ids that are all digits", () => {
    expect(
      toAndroidAppUrl("https://www.coupang.com/vp/products/8556671403?itemId=1a&vendorItemId=2"),
    ).toBe(`${SHARE}&vendorItemId=2`);
    expect(
      toAndroidAppUrl("https://www.coupang.com/vp/products/8556671403?itemId=&vendorItemId=-2"),
    ).toBe(SHARE);
  });

  it("takes the first option value and ignores lookalike parameter names", () => {
    expect(
      toAndroidAppUrl(
        "https://www.coupang.com/vp/products/8556671403?xitemId=9&itemId=1&itemId=3&vendorItemId",
      ),
    ).toBe(`${SHARE}&itemId=1`);
  });

  it("does not throw on malformed percent-encoding in the query", () => {
    expect(
      toAndroidAppUrl("https://www.coupang.com/vp/products/8556671403?q=%E0%A4%A&itemId=1"),
    ).toBe(`${SHARE}&itemId=1`);
  });

  it.each([
    "https://www.coupang.com/vp/products/85566a1403",
    "https://www.coupang.com/vp/products/",
    "https://www.coupang.com/vp/products/8556671403/reviews",
    "https://www.coupang.com/vm/products/8556671403",
    "https://m.coupang.com/vp/products/8556671403",
    "https://www.coupang.com/np/search?q=%EB%83%89%EC%9E%A5%EA%B3%A0",
    "https://www.coupang.com/np/categories/178255",
    "https://link.coupang.com/re/CSHARESDP?pageKey=8556671403",
    "https://link.coupang.com/a/abc123",
    "https://pages.coupang.com/vp/products/8556671403",
    "https://coupang.com.evil.net/vp/products/8556671403",
    "https://notcoupang.com/vp/products/8556671403",
    "https://www.coupang.com@evil.net/vp/products/8556671403",
    "https://www.danawa.com/vp/products/8556671403",
    "coupang://vp/products/8556671403",
    "not a url",
    "",
  ])("leaves %j unchanged", (url) => {
    expect(toAndroidAppUrl(url)).toBe(url);
  });
});
