import { describe, expect, test } from "vitest";
import { planStreamInputCdpSteps } from "./stream-input.js";

describe("planStreamInputCdpSteps", () => {
  test("maps a tap to a trusted press and release at guest coordinates", () => {
    const steps = planStreamInputCdpSteps({ kind: "tap", x: 120.5, y: 340 });
    expect(steps).toEqual([
      {
        command: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 120.5, y: 340, button: "left", clickCount: 1 },
      },
      {
        command: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 120.5, y: 340, button: "left", clickCount: 1 },
      },
    ]);
  });

  test("adds a second click for double taps", () => {
    const steps = planStreamInputCdpSteps({ kind: "tap", x: 10, y: 10, doubleTap: true });
    expect(steps).toHaveLength(4);
    expect(steps?.[2]?.params).toMatchObject({ type: "mousePressed", clickCount: 2 });
  });

  test("maps scrolls to wheel events", () => {
    expect(
      planStreamInputCdpSteps({ kind: "scroll", x: 200, y: 300, deltaX: 0, deltaY: 480 }),
    ).toEqual([
      {
        command: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 480 },
      },
    ]);
  });

  test("maps text to insertText", () => {
    expect(planStreamInputCdpSteps({ kind: "text", text: "hello" })).toEqual([
      { command: "Input.insertText", params: { text: "hello" } },
    ]);
  });

  test("sends Enter with a char event so submit handlers fire", () => {
    const steps = planStreamInputCdpSteps({ kind: "key", key: "Enter" });
    expect(steps?.map((step) => step.params.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(steps?.[0]?.params).toMatchObject({ windowsVirtualKeyCode: 13, text: "\r" });
  });

  test("sends Backspace without a char event", () => {
    const steps = planStreamInputCdpSteps({ kind: "key", key: "Backspace" });
    expect(steps?.map((step) => step.params.type)).toEqual(["rawKeyDown", "keyUp"]);
  });

  test("returns null for navigation inputs the caller handles on the tab", () => {
    expect(planStreamInputCdpSteps({ kind: "back" })).toBeNull();
    expect(planStreamInputCdpSteps({ kind: "forward" })).toBeNull();
    expect(planStreamInputCdpSteps({ kind: "reload" })).toBeNull();
    expect(planStreamInputCdpSteps({ kind: "navigate", url: "https://example.com" })).toBeNull();
  });
});
