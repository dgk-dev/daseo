import { describe, expect, it } from "vitest";
import { noteScreenshotFollowsPane } from "./screenshot-viewport";

type Payload = Parameters<typeof noteScreenshotFollowsPane>[0];

const screenshot: Payload = {
  requestId: "req-shot",
  ok: true,
  result: {
    command: "screenshot",
    browserId: "browser-1",
    mimeType: "image/png",
    dataBase64: "AAAA",
    width: 1224,
    height: 1080,
  },
};
const pane = { width: 612.4, height: 540 };

describe("noteScreenshotFollowsPane", () => {
  it("names the pane size for a Responsive tab a pane presents", () => {
    const noted = noteScreenshotFollowsPane(screenshot, {
      viewport: { mode: "responsive" },
      presentedPaneSize: pane,
    });

    expect(noted).toEqual({
      ...screenshot,
      result: { ...screenshot.result, followsPane: { width: 612, height: 540 } },
    });
  });

  it("leaves a parked Responsive tab alone: it is 1280x800 whatever panes are open", () => {
    expect(
      noteScreenshotFollowsPane(screenshot, {
        viewport: { mode: "responsive" },
        presentedPaneSize: null,
      }),
    ).toBe(screenshot);
  });

  it("leaves a fixed viewport alone, presented or not", () => {
    expect(
      noteScreenshotFollowsPane(screenshot, {
        viewport: { mode: "fixed", width: 390, height: 844 },
        presentedPaneSize: pane,
      }),
    ).toBe(screenshot);
  });

  it("leaves a tab the store does not know alone", () => {
    expect(noteScreenshotFollowsPane(screenshot, { viewport: null, presentedPaneSize: pane })).toBe(
      screenshot,
    );
  });

  it("leaves failures and other commands alone", () => {
    const failure: Payload = {
      requestId: "req-shot",
      ok: false,
      error: { code: "screenshot_no_frame", message: "not painted", retryable: true },
    };
    const tab = { viewport: { mode: "responsive" as const }, presentedPaneSize: pane };

    expect(noteScreenshotFollowsPane(failure, tab)).toBe(failure);
  });
});
