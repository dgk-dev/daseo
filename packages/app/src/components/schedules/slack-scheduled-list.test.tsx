/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AggregatedSlackScheduled,
  SlackScheduledFetchResult,
} from "@/schedules/slack-scheduled";

vi.stubGlobal("React", React);

const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/utils/open-external-url", () => ({ openExternalUrl }));
vi.mock("lucide-react-native", () => ({
  CalendarClock: () => null,
  MessageSquare: () => null,
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

import { SlackScheduledList } from "./slack-scheduled-list";

function noop(): void {}

function listData(entries: AggregatedSlackScheduled[]): SlackScheduledFetchResult {
  return { entries, hostErrors: [], warnings: [] };
}

const NOW_S = Math.floor(Date.now() / 1000);

function entry(overrides: Partial<AggregatedSlackScheduled>): AggregatedSlackScheduled {
  return {
    id: "Q1",
    as: "me",
    toLabel: "김여미 이사 (DM)",
    channel: "D1",
    postAt: NOW_S + 3600,
    firstLine: "이사님 내일 회의 자료입니다",
    status: "scheduled",
    createdAt: 0,
    serverId: "srv",
    serverName: "Mac",
    ...overrides,
  };
}

describe("SlackScheduledList (delta 135)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    openExternalUrl.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(entries: AggregatedSlackScheduled[], serverId: string | null = null): void {
    const data = listData(entries);
    act(() =>
      root.render(
        <SlackScheduledList
          data={data}
          isLoading={false}
          isError={false}
          serverId={serverId}
          singleHost
          onRetry={noop}
        />,
      ),
    );
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it("shows the empty state with the note about Slack-app schedules", () => {
    render([]);
    const empty = byTestId("slack-scheduled-empty");
    expect(empty?.textContent).toContain("예약된 슬랙 메시지가 없습니다");
    expect(empty?.textContent).toContain("슬랙 앱에서 직접 건 예약은 여기 나오지 않습니다");
  });

  it("lists upcoming and past rows with recipient, sender, chip, and failure reason", () => {
    render([
      entry({ id: "UP" }),
      entry({
        id: "FAIL",
        as: "bot",
        toLabel: "#ax",
        status: "failed",
        postAt: NOW_S - 3600,
        error: "channel_not_found",
      }),
    ]);
    const up = byTestId("slack-scheduled-row-UP");
    expect(up?.textContent).toContain("이사님 내일 회의 자료입니다");
    expect(up?.textContent).toContain("김여미 이사 (DM)");
    expect(up?.textContent).toContain("본인");
    expect(up?.textContent).toContain("예정");
    const failed = byTestId("slack-scheduled-row-FAIL");
    expect(failed?.textContent).toContain("알림봇");
    expect(failed?.textContent).toContain("실패");
    expect(failed?.textContent).toContain("channel_not_found");
    expect(container.textContent).toContain("지난 30일");
    expect(byTestId("slack-scheduled-empty")).toBeNull();
  });

  it("opens the permalink of a sent message and does nothing for one without", () => {
    const permalink = "https://dfcorp.slack.com/archives/D1/p1";
    render([
      entry({ id: "SENT", status: "sent", postAt: NOW_S - 60, permalink }),
      entry({ id: "UNVERIFIED", status: "unverified", postAt: NOW_S - 120 }),
    ]);
    act(() => byTestId("slack-scheduled-row-UNVERIFIED")?.click());
    expect(openExternalUrl).not.toHaveBeenCalled();
    act(() => byTestId("slack-scheduled-row-SENT")?.click());
    expect(openExternalUrl).toHaveBeenCalledWith(permalink);
  });

  it("shows only the chosen host's rows", () => {
    render([entry({ id: "A", serverId: "a" }), entry({ id: "B", serverId: "b" })], "b");
    expect(byTestId("slack-scheduled-row-A")).toBeNull();
    expect(byTestId("slack-scheduled-row-B")).not.toBeNull();
  });

  it("offers no cancel, reschedule, or send-now action", () => {
    render([entry({ id: "UP" })]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Cancel|Run now|Send now|Reschedule/);
  });
});
