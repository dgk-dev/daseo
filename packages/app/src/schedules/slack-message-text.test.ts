import { describe, expect, it } from "vitest";
import {
  fromEditableSlackText,
  slackDisplayFirstLine,
  slackDisplaySegments,
  slackDisplayText,
  toEditableSlackText,
} from "./slack-message-text";

const NAMES = { U0DOYOUNG: "도영", U0YEOMI01: "김여미", W0KIM0001: "김" };

describe("slackDisplayText (delta 135, 2026-11-23)", () => {
  it("shows Slack markup the way Slack reads it", () => {
    const wire =
      "<@U0DOYOUNG> <@U0NOBODY1> <@U0LABEL01|민수> <#C0AX|ax> <#C0RAW> <!here> <!channel|channel> " +
      "<!subteam^S0TEAM|@dev> <https://x.com/a?b=1&amp;c=2|자료> <https://x.com> <mailto:a@b.co|메일> " +
      "*굵게* &lt;tag&gt; &amp; <!date^1795000000^{date}|11월 24일> <nonsense>";
    expect(slackDisplayText(wire, NAMES)).toBe(
      "@도영 <@U0NOBODY1> @민수 #ax <#C0RAW> @here @channel @dev 자료 https://x.com 메일 " +
        "*굵게* <tag> & 11월 24일 <nonsense>",
    );
  });

  it("marks mentions and links as their own segments and keeps line breaks", () => {
    expect(
      slackDisplaySegments("안녕 <@U0DOYOUNG>\n<https://x.com|자료> 봐 주세요", NAMES),
    ).toEqual([
      { kind: "text", text: "안녕 " },
      { kind: "mention", text: "@도영" },
      { kind: "text", text: "\n" },
      { kind: "link", text: "자료" },
      { kind: "text", text: " 봐 주세요" },
    ]);
  });

  it("gives the first non-empty display line for a closed row", () => {
    expect(slackDisplayFirstLine("\n\n  <@U0DOYOUNG> 확인 부탁드립니다  \n둘째 줄", NAMES)).toBe(
      "@도영 확인 부탁드립니다",
    );
    expect(slackDisplayFirstLine("<@U0DOYOUNG> 이름 모름", null)).toBe("<@U0DOYOUNG> 이름 모름");
  });
});

describe("toEditableSlackText / fromEditableSlackText (delta 135, 2026-11-23)", () => {
  const cases: [string, string, Record<string, string> | null][] = [
    ["plain", "그냥 글입니다\n*굵게* <https://x.com|링크> &amp;", NAMES],
    ["known mention", "<@U0DOYOUNG> 확인 부탁드립니다", NAMES],
    ["unknown and labelled", "<@U0NOBODY1> <@U0DOYOUNG|도영> 와 <@U0YEOMI01>", NAMES],
    ["name already typed", "@도영 님, <@U0DOYOUNG> 확인", NAMES],
    ["two ids one name", "<@U0AAAAAA1> <@U0BBBBBB2>", { U0AAAAAA1: "민수", U0BBBBBB2: "민수" }],
    ["prefix names", "<@W0KIM0001> 과 <@U0YEOMI01>", NAMES],
    ["name runs into text", "<@W0KIM0001>여미 님", { W0KIM0001: "김", U0YEOMI01: "김여미" }],
    ["regex characters", "<@U0DOT0001> 안녕", { U0DOT0001: "a.b (c)" }],
    ["no names", "<@U0DOYOUNG>", null],
    ["empty", "", NAMES],
  ];

  it.each(cases)("gives the text back exactly: %s", (_label, text, mentions) => {
    const { editable, names } = toEditableSlackText(text, mentions);
    expect(fromEditableSlackText(editable, names)).toBe(text);
  });

  it("shows safe mentions as @이름 and leaves the rest in code form", () => {
    expect(toEditableSlackText("<@U0DOYOUNG> 와 <@U0NOBODY1>", NAMES).editable).toBe(
      "@도영 와 <@U0NOBODY1>",
    );
    expect(toEditableSlackText("@도영 님, <@U0DOYOUNG>", NAMES).editable).toBe(
      "@도영 님, <@U0DOYOUNG>",
    );
    expect(
      toEditableSlackText("<@U0AAAAAA1> <@U0BBBBBB2>", { U0AAAAAA1: "민수", U0BBBBBB2: "민수" })
        .editable,
    ).toBe("<@U0AAAAAA1> <@U0BBBBBB2>");
    // "김" next to "여미" would read back as 김여미: kept in code form.
    expect(
      toEditableSlackText("<@W0KIM0001>여미 님 <@U0YEOMI01>", {
        W0KIM0001: "김",
        U0YEOMI01: "김여미",
      }).editable,
    ).toBe("<@W0KIM0001>여미 님 @김여미");
  });

  it("turns an edited @이름 back into the mention and leaves other text alone", () => {
    const { editable, names } = toEditableSlackText("<@U0DOYOUNG> 내일 9시", NAMES);
    const edited = editable.replace("내일 9시", "모레 10시, @도영 님 꼭 봐 주세요 @모르는사람");
    expect(fromEditableSlackText(edited, names)).toBe(
      "<@U0DOYOUNG> 모레 10시, <@U0DOYOUNG> 님 꼭 봐 주세요 @모르는사람",
    );
  });
});
