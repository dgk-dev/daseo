/**
 * Daseo delta 135 (2026-11-23): the 시간 변경 editor's time, always Korea time. Computed from a
 * fixed +9 h offset like formatSlackPostTime (Korea has no daylight saving time), so builds without
 * full time-zone data read and print the same times. Pure functions; times are Unix seconds.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Slack schedules at most 120 days ahead and needs at least a minute (pi-local checks the same). */
export const SLACK_POST_MAX_DAYS = 120;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-11-24 09:00" in Korea time: the editor's starting text. */
export function formatSlackTimeInput(postAtSeconds: number): string {
  const kst = new Date(postAtSeconds * 1000 + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

export type SlackTimeInput = { ok: true; postAt: number } | { ok: false; error: string };

/** Unix seconds of a Korea-time wall clock, or null when the date does not exist. */
function kstWallClock(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): number | null {
  const { year, month, day, hour, minute } = parts;
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return (utc - KST_OFFSET_MS) / 1000;
}

/** Reads the editor's text as Korea time; refuses a past time, less than a minute, or >120 days. */
export function parseSlackTimeInput(input: string, nowMs: number): SlackTimeInput {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s*$/.exec(input);
  if (!match) return { ok: false, error: "2026-11-24 09:00 형식으로 적어 주세요." };
  const postAt = kstWallClock({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  });
  if (postAt === null) return { ok: false, error: "없는 날짜나 시각입니다." };
  if (postAt * 1000 < nowMs + MINUTE_MS) {
    return { ok: false, error: "지난 시각입니다. 지금부터 1분 넘게 뒤로 골라 주세요." };
  }
  if (postAt * 1000 > nowMs + SLACK_POST_MAX_DAYS * DAY_MS) {
    return { ok: false, error: `슬랙은 ${SLACK_POST_MAX_DAYS}일 뒤까지만 예약할 수 있습니다.` };
  }
  return { ok: true, postAt };
}

/** Rounded the way the row's relative time is (formatNextRun), so one screen shows one distance. */
function relative(postAtSeconds: number, nowMs: number): string {
  const diff = postAtSeconds * 1000 - nowMs;
  if (diff < 0) return "지남";
  if (diff < MINUTE_MS) return "곧";
  if (diff < HOUR_MS) return `${Math.round(diff / MINUTE_MS)}분 뒤`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)}시간 뒤`;
  return `${Math.round(diff / DAY_MS)}일 뒤`;
}

/** How the editor read the time: "11/24 (화) 09:00 · 18시간 뒤". */
export function describeSlackTime(postAtSeconds: number, nowMs: number): string {
  const kst = new Date(postAtSeconds * 1000 + KST_OFFSET_MS);
  const day = WEEKDAYS[kst.getUTCDay()] ?? "";
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} (${day}) ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} · ${relative(postAtSeconds, nowMs)}`;
}

export interface SlackQuickTime {
  key: "plus-hour" | "tomorrow" | "next-workday";
  label: string;
  postAt: number;
}

/** 09:00 Korea time `days` calendar days after today in Korea. */
function nineAm(nowMs: number, days: number): { postAt: number; weekday: number } {
  const today = new Date(nowMs + KST_OFFSET_MS);
  const target = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days, 9, 0),
  );
  return { postAt: (target.getTime() - KST_OFFSET_MS) / 1000, weekday: target.getUTCDay() };
}

/**
 * The editor's quick choices: an hour after `baseSeconds` (the time in the field, else the current
 * send time), tomorrow 09:00, and the next weekday 09:00 (Saturday and Sunday skipped; public
 * holidays are not known here).
 */
export function slackQuickTimes(baseSeconds: number, nowMs: number): SlackQuickTime[] {
  let workday = nineAm(nowMs, 1);
  for (let days = 2; workday.weekday === 0 || workday.weekday === 6; days += 1) {
    workday = nineAm(nowMs, days);
  }
  return [
    { key: "plus-hour", label: "+1시간", postAt: baseSeconds + 3600 },
    { key: "tomorrow", label: "내일 09:00", postAt: nineAm(nowMs, 1).postAt },
    { key: "next-workday", label: "다음 영업일 09:00", postAt: workday.postAt },
  ];
}
