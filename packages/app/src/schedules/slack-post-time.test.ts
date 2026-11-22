import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNextRun } from "@/utils/schedule-format";
import {
  describeSlackTime,
  formatSlackTimeInput,
  parseSlackTimeInput,
  slackQuickTimes,
} from "./slack-post-time";

// Sunday 2026-11-22 15:00 KST.
const SUNDAY_3PM = Date.UTC(2026, 10, 22, 6, 0, 0);
// Monday 2026-11-23 09:00 KST, Friday 2026-11-27 18:00 KST.
const MON_9AM_S = Date.UTC(2026, 10, 23, 0, 0, 0) / 1000;
const FRIDAY_6PM = Date.UTC(2026, 10, 27, 9, 0, 0);

describe("slack post time in Korea time (delta 135, 2026-11-23)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints and reads the editor's text in Korea time whatever the device zone", () => {
    expect(formatSlackTimeInput(MON_9AM_S)).toBe("2026-11-23 09:00");
    expect(parseSlackTimeInput("2026-11-23 09:00", SUNDAY_3PM)).toEqual({
      ok: true,
      postAt: MON_9AM_S,
    });
    expect(parseSlackTimeInput(" 2026-11-23 9:00 ", SUNDAY_3PM)).toEqual({
      ok: true,
      postAt: MON_9AM_S,
    });
  });

  it("refuses text it cannot read, dates that do not exist, the past, and more than 120 days", () => {
    const error = (input: string) => {
      const result = parseSlackTimeInput(input, SUNDAY_3PM);
      return result.ok ? null : result.error;
    };
    expect(error("내일 9시")).toMatch(/형식으로/);
    expect(error("2026-02-30 09:00")).toMatch(/없는 날짜/);
    expect(error("2026-11-23 24:00")).toMatch(/없는 날짜/);
    expect(error("2026-11-22 14:59")).toMatch(/지난 시각/);
    expect(error("2026-11-22 15:00")).toMatch(/지난 시각/);
    expect(error("2027-03-23 09:00")).toMatch(/120일/);
    expect(error("2026-11-22 15:02")).toBeNull();
  });

  it("echoes how the time was read", () => {
    expect(describeSlackTime(MON_9AM_S, SUNDAY_3PM)).toBe("11/23 (월) 09:00 · 18시간 뒤");
    expect(describeSlackTime(SUNDAY_3PM / 1000 + 25 * 60, SUNDAY_3PM)).toBe(
      "11/22 (일) 15:25 · 25분 뒤",
    );
    expect(describeSlackTime(MON_9AM_S + 3 * 86_400, SUNDAY_3PM)).toBe("11/26 (목) 09:00 · 4일 뒤");
  });

  it("rounds the distance the way the row's relative time does", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SUNDAY_3PM);
    const minutes = [
      0.5,
      1.4,
      29.6,
      59.4,
      89,
      8 * 60 + 55,
      23 * 60 + 40,
      36 * 60,
      3 * 24 * 60 + 600,
    ];
    for (const m of minutes) {
      const postAt = SUNDAY_3PM / 1000 + m * 60;
      const row = formatNextRun(new Date(postAt * 1000).toISOString());
      const echo = describeSlackTime(postAt, SUNDAY_3PM).split(" · ")[1];
      const expected = row
        .replace(/^soon$/, "곧")
        .replace(/^in (\d+)m$/, "$1분 뒤")
        .replace(/^in (\d+)h$/, "$1시간 뒤")
        .replace(/^in (\d+)d$/, "$1일 뒤");
      expect(echo, `${m} minutes ahead (row "${row}")`).toBe(expected);
    }
    expect(describeSlackTime(SUNDAY_3PM / 1000 + (8 * 60 + 55) * 60, SUNDAY_3PM)).toMatch(
      /· 9시간 뒤$/,
    );
  });

  it("offers +1 hour, tomorrow 09:00, and the next weekday 09:00", () => {
    expect(slackQuickTimes(MON_9AM_S, SUNDAY_3PM)).toEqual([
      { key: "plus-hour", label: "+1시간", postAt: MON_9AM_S + 3600 },
      { key: "tomorrow", label: "내일 09:00", postAt: MON_9AM_S },
      { key: "next-workday", label: "다음 영업일 09:00", postAt: MON_9AM_S },
    ]);
    const friday = slackQuickTimes(MON_9AM_S, FRIDAY_6PM);
    expect(friday[1]?.postAt).toBe(Date.UTC(2026, 10, 28, 0, 0, 0) / 1000); // Saturday
    expect(friday[2]?.postAt).toBe(Date.UTC(2026, 10, 30, 0, 0, 0) / 1000); // Monday
    // 23:30 KST on a Tuesday: "tomorrow" is the next Korea date, not the device's.
    const lateTuesday = Date.UTC(2026, 10, 24, 14, 30, 0);
    expect(slackQuickTimes(MON_9AM_S, lateTuesday)[1]?.postAt).toBe(
      Date.UTC(2026, 10, 25, 0, 0, 0) / 1000,
    );
  });
});
