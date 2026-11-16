import { describe, expect, it } from "vitest";
import { formatBrowserTabStage, redactBrowserUrlForLog } from "./tab-stage-log";

describe("browser tab stage log", () => {
  it("keeps only origin and path of a URL", () => {
    expect(redactBrowserUrlForLog("https://search.google.com/u/0/x?resource_id=sc-domain#y")).toBe(
      "https://search.google.com/u/0/x",
    );
    expect(redactBrowserUrlForLog("javascript:alert(1)")).toBe("javascript:…");
    expect(redactBrowserUrlForLog(undefined)).toBe("");
  });

  it("writes one line with the stage and its fields, URLs redacted, empty fields dropped", () => {
    expect(
      formatBrowserTabStage("new_tab failed", {
        browserId: "b1",
        ms: 5003,
        stage: "waiting-for-identity",
        reason: "still waiting for identity",
        url: "https://a.example/p?token=1",
        tabId: undefined,
        workspaceId: "",
      }),
    ).toBe(
      '[browser-tab] new_tab failed browserId=b1 ms=5003 stage=waiting-for-identity reason="still waiting for identity" url=https://a.example/p',
    );
  });
});
