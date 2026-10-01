import { describe, expect, it } from "vitest";
import { isWaitNotedReply, lastAssistantRun, WAIT_NOTED_REPLY } from "./wait-noted.js";

describe("isWaitNotedReply", () => {
  it("matches the footer token with the wrappers models add", () => {
    expect(WAIT_NOTED_REPLY).toBe("[wait noted]");
    for (const text of ["[wait noted]", " `[wait noted]` ", "[Wait Noted].", "\n[wait noted]\n"]) {
      expect(isWaitNotedReply(text)).toBe(true);
    }
  });

  it("does not match an answer that contains the token", () => {
    for (const text of [
      "",
      "wait noted",
      "[wait noted] and the deploy failed",
      "No response requested.",
    ]) {
      expect(isWaitNotedReply(text)).toBe(false);
    }
  });
});

describe("lastAssistantRun", () => {
  interface Item {
    role: "assistant" | "user";
    text: string;
  }
  const run = (items: Item[]) =>
    lastAssistantRun(
      items.length,
      (index) => items[index],
      (item) => (item.role === "assistant" ? item.text : null),
    );

  it("joins the last contiguous assistant chunks", () => {
    expect(
      run([
        { role: "user", text: "go" },
        { role: "assistant", text: "a" },
        { role: "assistant", text: "b" },
        { role: "user", text: "wake" },
      ]),
    ).toEqual({ text: "ab", startIndex: 1 });
  });

  it("skips runs that are only the wait-noted reply, even split across chunks", () => {
    expect(
      run([
        { role: "assistant", text: "report" },
        { role: "user", text: "wake" },
        { role: "assistant", text: "[wait" },
        { role: "assistant", text: " noted]" },
        { role: "user", text: "wake" },
        { role: "assistant", text: "[wait noted]" },
      ]),
    ).toEqual({ text: "report", startIndex: 0 });
    expect(run([{ role: "assistant", text: "[wait noted]" }])).toBeNull();
    expect(run([])).toBeNull();
  });
});
