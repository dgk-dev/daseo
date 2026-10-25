import { createContext, runInContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { promptShimInstallScript } from "./dialog-handling.js";

interface PromptShimHandle {
  installed(): boolean;
  drain(): unknown[];
  restore(): boolean;
}

function pageWithPrompt() {
  const context = createContext({});
  runInContext(
    "globalThis.window = globalThis; window.prompt = function prompt() { return 'typed'; };",
    context,
  );
  const globals = () =>
    runInContext(
      "[...Object.getOwnPropertyNames(window), ...Object.getOwnPropertySymbols(window).map(String)]",
      context,
    ) as string[];
  return { context, globals };
}

describe("prompt shim", () => {
  test("adds no global to the page and records prompts while installed", () => {
    const { context, globals } = pageWithPrompt();
    const before = globals();

    const handle = runInContext(promptShimInstallScript(), context) as PromptShimHandle;

    expect(globals()).toEqual(before);
    expect(runInContext("window.prompt('Name?', 'Ada')", context)).toBeNull();
    expect(handle.installed()).toBe(true);
    expect(handle.drain()).toEqual([
      {
        type: "prompt",
        message: "Name?",
        defaultValue: "Ada",
        action: "dismissed",
        timestamp: expect.any(Number),
      },
    ]);
    expect(handle.drain()).toEqual([]);

    handle.restore();

    expect(runInContext("window.prompt()", context)).toBe("typed");
    expect(handle.installed()).toBe(false);
    expect(globals()).toEqual(before);
  });

  test("restore leaves a prompt the page replaced in the meantime alone", () => {
    const { context } = pageWithPrompt();
    const handle = runInContext(promptShimInstallScript(), context) as PromptShimHandle;

    runInContext("window.prompt = () => 'page';", context);
    handle.restore();

    expect(runInContext("window.prompt()", context)).toBe("page");
  });
});
