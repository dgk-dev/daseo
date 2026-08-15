import type { BrowserAutomationStreamInput } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export interface StreamInputCdpStep {
  command: string;
  params: Record<string, unknown>;
}

const KEY_CODES: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
};

function mouseClickSteps(input: {
  x: number;
  y: number;
  button: string;
  clickCount: number;
}): StreamInputCdpStep[] {
  const base = { x: input.x, y: input.y, button: input.button, clickCount: input.clickCount };
  return [
    { command: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...base } },
    { command: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...base } },
  ];
}

/**
 * Translate a remote stream input into CDP command steps. Navigation kinds
 * (back/forward/reload/navigate) are handled by the caller on the tab itself
 * and return null here.
 */
export function planStreamInputCdpSteps(
  input: BrowserAutomationStreamInput,
): StreamInputCdpStep[] | null {
  switch (input.kind) {
    case "tap": {
      const button = input.button ?? "left";
      const steps = mouseClickSteps({ x: input.x, y: input.y, button, clickCount: 1 });
      if (input.doubleTap) {
        steps.push(...mouseClickSteps({ x: input.x, y: input.y, button, clickCount: 2 }));
      }
      return steps;
    }
    case "scroll":
      return [
        {
          command: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          },
        },
      ];
    case "text":
      return [{ command: "Input.insertText", params: { text: input.text } }];
    case "key": {
      const key = KEY_CODES[input.key];
      const base = {
        key: input.key,
        code: key.code,
        windowsVirtualKeyCode: key.windowsVirtualKeyCode,
        nativeVirtualKeyCode: key.windowsVirtualKeyCode,
        ...(key.text !== undefined ? { text: key.text, unmodifiedText: key.text } : {}),
      };
      return [
        { command: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...base } },
        ...(key.text !== undefined
          ? [{ command: "Input.dispatchKeyEvent", params: { type: "char", ...base } }]
          : []),
        { command: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
      ];
    }
    case "back":
    case "forward":
    case "reload":
    case "navigate":
      return null;
  }
}
