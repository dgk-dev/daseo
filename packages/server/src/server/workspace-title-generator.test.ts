import { expect, test } from "vitest";
import {
  buildWorkspaceTitlePrompt,
  cleanGeneratedWorkspaceTitle,
  MAX_GENERATED_WORKSPACE_TITLE_CHARS,
} from "./workspace-title-generator.js";

test("cleans quotes, trailing periods, and extra lines from generated titles", () => {
  expect(cleanGeneratedWorkspaceTitle('"Daseo 세션 자동 이름."\nextra')).toBe(
    "Daseo 세션 자동 이름",
  );
  expect(cleanGeneratedWorkspaceTitle("   ")).toBeNull();
  expect(cleanGeneratedWorkspaceTitle("가".repeat(60))).toHaveLength(
    MAX_GENERATED_WORKSPACE_TITLE_CHARS,
  );
});

test("the prompt asks for a fresh title without a current one and a keep decision with one", () => {
  const fresh = buildWorkspaceTitlePrompt({
    currentTitle: null,
    recentPrompts: ["세션 이름 고쳐줘"],
  });
  expect(fresh).toContain("There is no title yet");
  expect(fresh).toContain("<message>세션 이름 고쳐줘</message>");

  const retitle = buildWorkspaceTitlePrompt({
    currentTitle: "Daseo 세션 자동 이름",
    recentPrompts: ["세션 이름 고쳐줘", "이제 결제 페이지 버그"],
  });
  expect(retitle).toContain("Current title: Daseo 세션 자동 이름");
  expect(retitle).toContain("When unsure, keep the current title.");
  expect(retitle).toContain("Earlier user messages");
});
