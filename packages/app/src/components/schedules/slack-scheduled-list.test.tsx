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

// Both entry points record into one mock so a test sees the order of every URL opened.
const openExternalUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl,
  tryOpenExternalUrl: openExternalUrl,
}));
vi.mock("lucide-react-native", () => ({
  ArrowUpRight: () => null,
  CalendarClock: () => null,
  MessageSquare: () => null,
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
const confirmDialog = vi.hoisted(() => vi.fn(async (_input: unknown) => true));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog }));
// A plain input stands in for the form kit's text field: these tests are about the row's flow.
vi.mock("@/components/ui/form-field", async () => {
  const { forwardRef, useCallback, useImperativeHandle, useRef } = await import("react");
  return {
    FormTextInput: forwardRef(function FakeInput(
      props: { initialValue?: string; onChangeText?: (text: string) => void; testID?: string },
      ref,
    ) {
      const input = useRef<HTMLInputElement | null>(null);
      const { onChangeText } = props;
      const handleChange = useCallback(
        (event: { target: { value: string } }) => onChangeText?.(event.target.value),
        [onChangeText],
      );
      useImperativeHandle(ref, () => ({
        replaceText: (text: string) => {
          if (input.current) input.current.value = text;
        },
      }));
      return (
        <input
          ref={input}
          data-testid={props.testID}
          defaultValue={props.initialValue}
          onChange={handleChange}
        />
      );
    }),
  };
});

import type { SlackScheduledActions } from "@/hooks/use-slack-scheduled";
import { SlackScheduledList } from "./slack-scheduled-list";

function noop(): void {}

function fakeActions(canChange = true) {
  return {
    canChange: vi.fn((_serverId: string) => canChange),
    cancel: vi.fn(async () => ({ ok: true as const, newId: null })),
    update: vi.fn(async () => ({ ok: true as const, newId: "QNEW" })),
  } satisfies SlackScheduledActions;
}

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
    openExternalUrl.mockReset().mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    entries: AggregatedSlackScheduled[],
    serverId: string | null = null,
    actions: SlackScheduledActions = fakeActions(false),
  ): void {
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
          actions={actions}
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

  it("opens a sent message from its row's open button; a row press opens the message instead", () => {
    const permalink = "https://dfcorp.slack.com/archives/D1/p1";
    render([
      entry({ id: "SENT", status: "sent", postAt: NOW_S - 60, permalink }),
      entry({ id: "UNVERIFIED", status: "unverified", postAt: NOW_S - 120 }),
    ]);
    expect(byTestId("slack-scheduled-row-open-UNVERIFIED")).toBeNull();
    act(() => byTestId("slack-scheduled-row-SENT")?.click());
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(byTestId("slack-scheduled-detail-SENT")).not.toBeNull();
    act(() => byTestId("slack-scheduled-row-open-SENT")?.click());
    expect(openExternalUrl).toHaveBeenCalledWith(permalink);
    openExternalUrl.mockClear();
    act(() => byTestId("slack-scheduled-open-SENT")?.click());
    expect(openExternalUrl).toHaveBeenCalledWith(permalink);
  });

  it("opens a sent message in the Slack app, and the permalink when no app takes the link", async () => {
    const permalink = "https://dfcorp.slack.com/archives/D1/p1795129200272279";
    const appLink = "slack://channel?team=T02004LSA0L&id=D1AB&message=1795129200.272279";
    render([entry({ id: "SENT", status: "sent", postAt: NOW_S - 60, permalink, appLink })]);

    await act(async () => byTestId("slack-scheduled-row-open-SENT")?.click());
    expect(openExternalUrl.mock.calls).toEqual([[appLink]]);

    openExternalUrl.mockReset();
    openExternalUrl.mockRejectedValueOnce(new Error("no app")).mockResolvedValue(true);
    await act(async () => byTestId("slack-scheduled-row-open-SENT")?.click());
    expect(openExternalUrl.mock.calls).toEqual([[appLink], [permalink]]);

    openExternalUrl.mockReset();
    openExternalUrl.mockResolvedValueOnce(false).mockResolvedValue(true);
    await act(async () => byTestId("slack-scheduled-row-open-SENT")?.click());
    expect(openExternalUrl.mock.calls).toEqual([[appLink], [permalink]]);
  });

  it("shows only the chosen host's rows", () => {
    render([entry({ id: "A", serverId: "a" }), entry({ id: "B", serverId: "b" })], "b");
    expect(byTestId("slack-scheduled-row-A")).toBeNull();
    expect(byTestId("slack-scheduled-row-B")).not.toBeNull();
  });

  it("opens a row in place to show the whole message with names, one row at a time", () => {
    render([
      entry({
        id: "UP",
        firstLine: "<@U0DOYOUNG> 확인 부탁드립니다",
        text: "<@U0DOYOUNG> 확인 부탁드립니다\n<https://x.com|자료> &amp; 둘째 줄",
        mentions: { U0DOYOUNG: "도영" },
      }),
      entry({ id: "OTHER", firstLine: "다른 글" }),
    ]);
    expect(byTestId("slack-scheduled-row-UP")?.textContent).toContain("@도영 확인 부탁드립니다");
    expect(byTestId("slack-scheduled-detail-UP")).toBeNull();
    act(() => byTestId("slack-scheduled-row-UP")?.click());
    expect(byTestId("slack-scheduled-text-UP")?.textContent).toBe(
      "@도영 확인 부탁드립니다\n자료 & 둘째 줄",
    );
    act(() => byTestId("slack-scheduled-row-OTHER")?.click());
    expect(byTestId("slack-scheduled-detail-UP")).toBeNull();
    expect(byTestId("slack-scheduled-text-OTHER")?.textContent).toBe("다른 글");
    act(() => byTestId("slack-scheduled-row-OTHER")?.click());
    expect(byTestId("slack-scheduled-detail-OTHER")).toBeNull();
  });

  it("offers no action on a host without the feature, and never a send-now", () => {
    render([entry({ id: "UP" })]);
    act(() => byTestId("slack-scheduled-row-UP")?.click());
    expect(byTestId("slack-scheduled-cancel-UP")).toBeNull();
    expect(byTestId("slack-scheduled-time-UP")).toBeNull();
    expect(byTestId("slack-scheduled-edit-UP")).toBeNull();
    expect(container.textContent).not.toMatch(/Send now|Run now|지금 보내기/);
  });

  it("cancels an upcoming message after the confirm, and not when the confirm is declined", async () => {
    const actions = fakeActions();
    render(
      [entry({ id: "UP" }), entry({ id: "SENT", status: "sent", postAt: NOW_S - 60 })],
      null,
      actions,
    );
    act(() => byTestId("slack-scheduled-row-SENT")?.click());
    expect(byTestId("slack-scheduled-cancel-SENT")).toBeNull();
    act(() => byTestId("slack-scheduled-row-UP")?.click());

    confirmDialog.mockResolvedValueOnce(false);
    await act(async () => byTestId("slack-scheduled-cancel-UP")?.click());
    expect(actions.cancel).not.toHaveBeenCalled();

    await act(async () => byTestId("slack-scheduled-cancel-UP")?.click());
    expect(confirmDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "이 예약을 취소할까요? 아무에게도 보내지 않습니다" }),
    );
    expect(actions.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: "UP" }));
    expect(byTestId("slack-scheduled-detail-UP")).toBeNull();
  });

  it("keeps the editor and its input when a change fails, and shows the reason", async () => {
    const actions = fakeActions();
    actions.update.mockResolvedValueOnce({ ok: false, error: "time_in_past" } as never);
    render([entry({ id: "UP", text: "원래 글" })], null, actions);
    act(() => byTestId("slack-scheduled-row-UP")?.click());
    act(() => byTestId("slack-scheduled-edit-UP")?.click());
    const input = byTestId("slack-scheduled-text-input-UP") as HTMLInputElement;
    expect(input.value).toBe("원래 글");
    const save = byTestId("slack-scheduled-text-save-UP");
    expect(save?.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "고친 글");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byTestId("slack-scheduled-text-save-UP")?.click());
    expect(actions.update).toHaveBeenCalledWith(expect.objectContaining({ id: "UP" }), {
      text: "고친 글",
    });
    expect(byTestId("slack-scheduled-action-error-UP")?.textContent).toBe("time_in_past");
    expect((byTestId("slack-scheduled-text-input-UP") as HTMLInputElement).value).toBe("고친 글");
  });

  it("does not offer 내용 수정 on a text at the length cap, which may have been cut", () => {
    render(
      [
        entry({ id: "LONG", text: `${"가".repeat(39_999)}…` }),
        entry({ id: "OK", text: "짧은 글" }),
      ],
      null,
      fakeActions(),
    );
    act(() => byTestId("slack-scheduled-row-LONG")?.click());
    expect(byTestId("slack-scheduled-edit-LONG")?.getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("slack-scheduled-too-long-LONG")?.textContent).toContain("너무 길어");
    act(() => byTestId("slack-scheduled-edit-LONG")?.click());
    expect(byTestId("slack-scheduled-text-editor-LONG")).toBeNull();
    act(() => byTestId("slack-scheduled-row-OK")?.click());
    expect(byTestId("slack-scheduled-edit-OK")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(byTestId("slack-scheduled-too-long-OK")).toBeNull();
  });

  it("reads the time editor's text in Korea time and refuses a past time", () => {
    render([entry({ id: "UP", postAt: NOW_S + 86_400 })], null, fakeActions());
    act(() => byTestId("slack-scheduled-row-UP")?.click());
    act(() => byTestId("slack-scheduled-time-UP")?.click());
    const input = byTestId("slack-scheduled-time-input-UP") as HTMLInputElement;
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(byTestId("slack-scheduled-time-read-UP")?.textContent).toMatch(/시간 뒤$/);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "2020-01-01 09:00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byTestId("slack-scheduled-time-read-UP")?.textContent).toMatch(/지난 시각/);
    expect(byTestId("slack-scheduled-time-save-UP")?.getAttribute("aria-disabled")).toBe("true");
  });
});
