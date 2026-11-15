import { describe, expect, it } from "vitest";
import { resolveSendErrorAfterInputChange, type SendErrorAnchor } from "./send-error";

function runEffect(
  renders: Array<{ error: string | null; userInput: string }>,
): Array<string | null> {
  // Mirrors the composer effect: each render feeds the error and input it shows.
  let anchor: SendErrorAnchor | null = null;
  const shown: Array<string | null> = [];
  for (const render of renders) {
    let error = render.error;
    const next = resolveSendErrorAfterInputChange({ error, userInput: render.userInput, anchor });
    anchor = next.anchor;
    if (next.clear) error = null;
    shown.push(error);
  }
  return shown;
}

describe("send error lifetime", () => {
  it("keeps the error when the failed message is restored into the input", () => {
    // Before: `if (sendError && userInput) setSendError(null)` cleared it on this very render.
    expect(runEffect([{ error: "Host went away", userInput: "hello" }])).toEqual([
      "Host went away",
    ]);
  });

  it("clears the error on the user's next edit", () => {
    let anchor: SendErrorAnchor | null = null;
    const restored = resolveSendErrorAfterInputChange({
      error: "Host went away",
      userInput: "hello",
      anchor,
    });
    anchor = restored.anchor;
    expect(restored.clear).toBe(false);
    const edited = resolveSendErrorAfterInputChange({
      error: "Host went away",
      userInput: "hello!",
      anchor,
    });
    expect(edited.clear).toBe(true);
  });

  it("re-anchors when a different error replaces the shown one", () => {
    const first = resolveSendErrorAfterInputChange({ error: "a", userInput: "x", anchor: null });
    const second = resolveSendErrorAfterInputChange({
      error: "b",
      userInput: "y",
      anchor: first.anchor,
    });
    expect(second).toEqual({ anchor: { error: "b", input: "y" }, clear: false });
  });
});
