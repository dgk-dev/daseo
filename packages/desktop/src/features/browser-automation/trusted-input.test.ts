import { describe, expect, test } from "vitest";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { dispatchTrustedKey, planCdpKeySteps } from "./trusted-input.js";

describe("trusted browser input", () => {
  test.each([
    ["a", "a", ["keyDown", "char", "keyUp"]],
    ["Z", "Z", ["keyDown", "char", "keyUp"]],
    ["ArrowDown", "Down", ["keyDown", "keyUp"]],
  ])(
    "sends %s as Electron key code %s with unhandled redispatch disabled",
    (key, keyCode, types) => {
      const events: IsolatedKeyboardInputEvent[] = [];

      dispatchTrustedKey((event) => {
        events.push(event);
      }, key);

      expect(events).toEqual(
        types.map((type) => ({
          type,
          keyCode,
          skipIfUnhandled: true,
        })),
      );
    },
  );

  test("inserts a named Space keypress", () => {
    const events: IsolatedKeyboardInputEvent[] = [];

    dispatchTrustedKey((event) => {
      events.push(event);
    }, "Space");

    expect(events).toEqual([
      { type: "keyDown", keyCode: "Space", skipIfUnhandled: true },
      { type: "char", keyCode: " ", skipIfUnhandled: true },
      { type: "keyUp", keyCode: "Space", skipIfUnhandled: true },
    ]);
  });

  // Daseo delta 110: keys for an out-of-process frame, as Input.dispatchKeyEvent.
  test.each([
    ["4", { type: "keyDown", key: "4", code: "Digit4", windowsVirtualKeyCode: 52, text: "4" }],
    ["b", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, text: "b" }],
    [
      "Enter",
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    ],
    ["Tab", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
    [
      "Down",
      { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ],
    ["F5", { type: "rawKeyDown", key: "F5", code: "F5", windowsVirtualKeyCode: 116 }],
  ])("plans %s for a frame's DevTools target", (key, down) => {
    const steps = planCdpKeySteps(key);
    expect(steps?.map((step) => step.command)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    expect(steps?.[0]?.params).toMatchObject(down);
    expect(steps?.[1]?.params).toMatchObject({ type: "keyUp", key: down.key, code: down.code });
    expect(steps?.[1]?.params).not.toHaveProperty("text");
  });

  test("has no plan for a key name it does not know", () => {
    expect(planCdpKeySteps("Control+A")).toBeNull();
  });
});
