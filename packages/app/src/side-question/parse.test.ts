import { describe, expect, it } from "vitest";
import { parseSideQuestionInput } from "@/side-question/parse";

describe("parseSideQuestionInput", () => {
  it("takes the question after /btw, across lines", () => {
    expect(parseSideQuestionInput(" /btw what was that config file? ")).toEqual({
      question: "what was that config file?",
    });
    expect(parseSideQuestionInput("/btw first line\nsecond line")).toEqual({
      question: "first line\nsecond line",
    });
  });

  it("treats a bare /btw as reopening the thread", () => {
    expect(parseSideQuestionInput("/btw")).toEqual({ question: "" });
    expect(parseSideQuestionInput("/btw   ")).toEqual({ question: "" });
  });

  it("leaves other input alone", () => {
    expect(parseSideQuestionInput("/btwx question")).toBeNull();
    expect(parseSideQuestionInput("hello /btw question")).toBeNull();
    expect(parseSideQuestionInput("/compact")).toBeNull();
  });
});
