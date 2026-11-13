import { describe, expect, test } from "vitest";
import { BrowserTabEventQueue } from "./tab-events.js";

describe("BrowserTabEventQueue", () => {
  test("a tab's events go out once, with the next result for that tab", () => {
    let clock = 1;
    const queue = new BrowserTabEventQueue(() => clock++);
    queue.record("tab-a", { type: "popup_opened", popupBrowserId: "pop-1", url: "https://x" });
    queue.record("tab-b", { type: "tab_opened", url: "https://y" });
    expect(queue.drain({ browserId: "tab-a" })).toEqual([
      {
        type: "popup_opened",
        popupBrowserId: "pop-1",
        url: "https://x",
        browserId: "tab-a",
        timestamp: 1,
      },
    ]);
    expect(queue.drain({ browserId: "tab-a" })).toEqual([]);
    expect(queue.drain({ browserId: "tab-b" })).toHaveLength(1);
  });

  test("an agent's next call carries events of every tab it used, popups included", () => {
    let clock = 1;
    const queue = new BrowserTabEventQueue(() => clock++);
    queue.linkAgent("tab-a", "agent-1");
    queue.linkAgent("tab-z", "agent-2");
    queue.linkPopup("pop-1", "tab-a");
    queue.record("pop-1", { type: "tab_closed" });
    queue.record("tab-a", { type: "download_started" });
    queue.record("tab-z", { type: "tab_opened" });

    const delivered = queue.drain({ agentId: "agent-1" });
    expect(delivered.map((event) => `${event.browserId}:${event.type}`)).toEqual([
      "pop-1:tab_closed",
      "tab-a:download_started",
    ]);
    expect(queue.drain({ agentId: "agent-1" })).toEqual([]);
    expect(queue.drain({ agentId: "agent-2" })).toHaveLength(1);
  });

  test("a tab keeps at most its 20 newest events", () => {
    const queue = new BrowserTabEventQueue();
    for (let index = 0; index < 25; index += 1) {
      queue.record("tab-a", { type: "tab_opened", url: `https://x/${index}` });
    }
    const delivered = queue.drain({ browserId: "tab-a" });
    expect(delivered).toHaveLength(20);
    expect(delivered[0]?.url).toBe("https://x/5");
  });

  test("a subscriber hears each event as it is recorded until it unsubscribes (delta 100)", () => {
    const queue = new BrowserTabEventQueue(() => 7);
    const heard: string[] = [];
    const stop = queue.subscribe((event) => heard.push(`${event.browserId}:${event.type}`));
    queue.record("tab-a", { type: "popup_opened", popupBrowserId: "pop-1" });
    stop();
    queue.record("tab-a", { type: "tab_closed" });
    expect(heard).toEqual(["tab-a:popup_opened"]);
    expect(queue.drain({ browserId: "tab-a" })).toHaveLength(2);
  });
});
