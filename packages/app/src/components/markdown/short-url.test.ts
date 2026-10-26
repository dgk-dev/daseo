import { describe, expect, it } from "vitest";
import { shortenBareUrlLabel } from "./short-url";

describe("shortenBareUrlLabel", () => {
  it("leaves short and labelled links alone", () => {
    expect(shortenBareUrlLabel("https://paseo.sh/docs", "https://paseo.sh/docs")).toBeNull();
    const long =
      "https://github.com/dgk-dev/daseo/blob/main/packages/app/src/components/message.tsx";
    expect(shortenBareUrlLabel(long, "message.tsx source")).toBeNull();
  });

  it("keeps the host and the last path segment and collapses the query", () => {
    const long =
      "https://github.com/dgk-dev/daseo/blob/main/packages/app/src/components/message.tsx?plain=1#L120";
    expect(shortenBareUrlLabel(long, long)).toBe("github.com/dgk-dev/…/message.tsx?…#…");
  });

  it("drops only the scheme when that is enough", () => {
    const url = "https://docs.example.com/guide/getting-started?utm_source=newsletter&x=1";
    expect(shortenBareUrlLabel(url, url)).toBe("docs.example.com/guide/getting-started?…");
  });

  it("clips a single very long segment", () => {
    const url = `https://example.com/${"a".repeat(60)}`;
    expect(shortenBareUrlLabel(url, url)).toBe(`example.com/${"a".repeat(23)}…`);
  });

  it("treats a linkified label without scheme as the same address", () => {
    const href = "http://www.example.com/a/very/long/path/that/keeps/going/and/going/index.html";
    expect(shortenBareUrlLabel(href, href.replace("http://", ""))).toBe(
      "www.example.com/a/…/index.html",
    );
  });
});
