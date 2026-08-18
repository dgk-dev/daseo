import { describe, expect, test } from "vitest";
import { BrowserAutomationActivityTracker } from "./activity.js";

describe("BrowserAutomationActivityTracker", () => {
  test("distinguishes recent agent input from human-focused browser activity", () => {
    let now = 1_000;
    const tracker = new BrowserAutomationActivityTracker(() => now, 1_000);

    expect(tracker.wasRecent(10)).toBe(false);
    tracker.mark(10);
    expect(tracker.wasRecent(10)).toBe(true);
    expect(tracker.wasRecent(11)).toBe(false);

    now = 2_001;
    expect(tracker.wasRecent(10)).toBe(false);
  });

  test("new activity extends the no-focus grace window", () => {
    let now = 1_000;
    const tracker = new BrowserAutomationActivityTracker(() => now, 500);
    tracker.mark(10);
    now = 1_400;
    tracker.mark(10);
    now = 1_800;

    expect(tracker.wasRecent(10)).toBe(true);
  });

  test("clear removes target activity during WebContents teardown", () => {
    const tracker = new BrowserAutomationActivityTracker(() => 1_000, 1_000);
    tracker.mark(10);
    tracker.clear(10);

    expect(tracker.wasRecent(10)).toBe(false);
  });
});
