import type { BrowserAutomationStreamInput } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export interface StreamInputCdpStep {
  command: string;
  params: Record<string, unknown>;
}

type StreamPointerInput = Extract<
  BrowserAutomationStreamInput,
  { kind: "tap" } | { kind: "scroll" }
>;

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

export function planStreamInputCdpSteps(input: StreamPointerInput): StreamInputCdpStep[] {
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
  }
}
