import { describe, expect, it } from "vitest";
import { isSlackAppLink } from "./slack-app-link";

describe("isSlackAppLink", () => {
  it("accepts a message link and a thread reply link", () => {
    expect(
      isSlackAppLink("slack://channel?team=T02004LSA0L&id=D0AQ557U7U2&message=1795129200.272279"),
    ).toBe(true);
    expect(
      isSlackAppLink(
        "slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100&thread_ts=1762999999.000200",
      ),
    ).toBe(true);
  });

  it("refuses every other shape", () => {
    for (const value of [
      null,
      42,
      "",
      "https://dfcorpo.slack.com/archives/C0AXCHAN01/p1763000000000100",
      "slack://open?team=T02004LSA0L",
      "slack://channel?team=T02004LSA0L&id=C0AXCHAN01",
      "slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100&x=1",
      "slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100#frag",
      "slack://channel?team=T02004LSA0L&team=T0OTHER01&id=C0AXCHAN01&message=1763000000.000100",
      "slack://channel?team=t02004lsa0l&id=C0AXCHAN01&message=1763000000.000100",
      "slack://channel?team=T02004LSA0L&id=U0AXCHAN01&message=1763000000.000100",
      "slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000",
      "slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100&",
      "SLACK://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100",
      `slack://channel?team=T02004LSA0L&id=C0AXCHAN01&message=1763000000.000100${"&thread_ts=1762999999.000200".repeat(8)}`,
    ]) {
      expect(isSlackAppLink(value)).toBe(false);
    }
  });
});
