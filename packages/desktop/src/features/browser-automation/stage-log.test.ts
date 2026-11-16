import { describe, expect, it, vi } from "vitest";

const mainLog = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: mainLog }));

import { logBrowserStage, redactStageFields, redactUrlForLog } from "./stage-log.js";

describe("browser stage log", () => {
  it("keeps only origin and path of a URL", () => {
    expect(
      redactUrlForLog(
        "https://search.google.com/u/0/search-console/performance?resource_id=sc-domain%3Ah-dex.jp#x",
      ),
    ).toBe("https://search.google.com/u/0/search-console/performance");
    expect(redactUrlForLog("data:text/html,<p>secret</p>")).toBe("data:…");
    expect(redactUrlForLog("not a url")).toBe("<invalid url>");
    expect(redactUrlForLog(null)).toBe("");
  });

  it("redacts every URL field and drops absent ones", () => {
    expect(
      redactStageFields({
        url: "https://a.example/p?token=1",
        requestedUrl: "https://b.example/q?code=2",
        code: -3,
        reason: undefined,
      }),
    ).toEqual({ url: "https://a.example/p", requestedUrl: "https://b.example/q", code: -3 });
  });

  it("writes one main.log line per stage", () => {
    logBrowserStage("browser-nav", "commit", {
      browserId: "b1",
      ms: 4,
      url: "https://a.example/p?x=1",
    });
    expect(mainLog.info).toHaveBeenCalledWith("[browser-nav] commit", {
      browserId: "b1",
      ms: 4,
      url: "https://a.example/p",
    });
  });
});
