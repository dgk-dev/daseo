import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import type { BrowserViewport } from "@/desktop/browser/store";

type BrowserAutomationResponsePayload = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>["payload"];

/**
 * A Responsive tab shown in a pane takes that pane's size, so a screenshot of it is as wide as
 * the pane the person has open, not the 1280x800 a background tab gets. The result says so
 * (`followsPane`), and the daemon tells the agent that `browser_resize` gives a fixed size. A
 * parked tab and a fixed viewport are left as they are.
 */
export function noteScreenshotFollowsPane(
  payload: BrowserAutomationResponsePayload,
  tab: {
    viewport: BrowserViewport | null;
    presentedPaneSize: { width: number; height: number } | null;
  },
): BrowserAutomationResponsePayload {
  if (!payload.ok || payload.result.command !== "screenshot") {
    return payload;
  }
  const { viewport, presentedPaneSize } = tab;
  if (viewport?.mode !== "responsive" || !presentedPaneSize) {
    return payload;
  }
  const width = Math.round(presentedPaneSize.width);
  const height = Math.round(presentedPaneSize.height);
  if (width <= 0 || height <= 0) {
    return payload;
  }
  return { ...payload, result: { ...payload.result, followsPane: { width, height } } };
}
