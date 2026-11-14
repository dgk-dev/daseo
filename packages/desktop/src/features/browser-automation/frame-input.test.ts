import { describe, expect, test } from "vitest";
import {
  listTabFrames,
  planFrameInputSteps,
  sendFrameInputThroughTarget,
  type WebFrameLike,
} from "./frame-input.js";

function webFrame(input: {
  id: number;
  processId: number;
  url?: string;
  parent?: WebFrameLike | null;
  run?: (code: string, userGesture?: boolean) => unknown;
}): WebFrameLike & { children: WebFrameLike[]; scripts: string[] } {
  const scripts: string[] = [];
  const frame = {
    frameTreeNodeId: input.id,
    processId: input.processId,
    url: input.url ?? `https://frame-${input.id}.test/`,
    parent: input.parent ?? null,
    children: [] as WebFrameLike[],
    scripts,
    get framesInSubtree(): WebFrameLike[] {
      return [frame, ...frame.children.flatMap((child) => child.framesInSubtree)];
    },
    async executeJavaScript(code: string, userGesture?: boolean) {
      scripts.push(code);
      return input.run?.(code, userGesture) ?? null;
    },
  };
  return frame;
}

describe("tab frames (delta 110)", () => {
  test("lists frames below the main frame with their parent and process boundary", async () => {
    const main = webFrame({ id: 1, processId: 10 });
    const sameSite = webFrame({ id: 2, processId: 10, parent: main });
    const card = webFrame({ id: 3, processId: 11, parent: main, run: () => "answered" });
    const inner = webFrame({ id: 4, processId: 11, parent: card });
    main.children.push(sameSite, card);
    card.children.push(inner);
    const gestures: boolean[] = [];

    const frames = listTabFrames(() => main, { beforeScript: (gesture) => gestures.push(gesture) });

    expect(
      frames.map(({ id, parentId, outOfProcess }) => ({ id, parentId, outOfProcess })),
    ).toEqual([
      { id: 2, parentId: null, outOfProcess: false },
      { id: 3, parentId: null, outOfProcess: true },
      { id: 4, parentId: 3, outOfProcess: false },
    ]);
    await expect(frames[1]?.executeJavaScript("1 + 1", true)).resolves.toBe("answered");
    expect(gestures).toEqual([true]);
    main.children.splice(1, 1);
    await expect(frames[1]?.executeJavaScript("1 + 1")).rejects.toThrow("The iframe is gone.");
  });

  test("sends input through the target whose window holds the key its frame just set", async () => {
    let key: string | null = null;
    const frame = webFrame({
      id: 3,
      processId: 11,
      url: "https://js.stripe.test/inner",
      run: (code) => {
        key = /value: "([^"]+)"/.exec(code)?.[1] ?? null;
        return true;
      },
    });
    const sent: Array<{ command: string; params?: Record<string, unknown>; sessionId?: string }> =
      [];
    const send = async (command: string, params?: Record<string, unknown>, sessionId?: string) => {
      sent.push({ command, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
      if (command === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "page", type: "page", url: "https://shop.test/" },
            { targetId: "other-tab", type: "iframe", url: "https://js.stripe.test/inner" },
            { targetId: "ours", type: "iframe", url: "https://js.stripe.test/inner" },
          ],
        };
      }
      if (command === "Target.attachToTarget") {
        return { sessionId: `session-${String(params?.targetId)}` };
      }
      if (command === "Runtime.evaluate") {
        return { result: { value: sessionId === "session-ours" ? key : "another" } };
      }
      return {};
    };

    await sendFrameInputThroughTarget({
      frame,
      send,
      steps: planFrameInputSteps({ kind: "text", text: "4242" }),
    });

    expect(sent.filter((entry) => entry.command.startsWith("Input."))).toEqual([
      { command: "Input.insertText", params: { text: "4242" }, sessionId: "session-ours" },
    ]);
    expect(
      sent
        .filter((entry) => entry.command === "Target.detachFromTarget")
        .map((entry) => entry.params),
    ).toEqual([{ sessionId: "session-other-tab" }, { sessionId: "session-ours" }]);
  });

  test("fails when no target holds the key, and for a key name it cannot send", async () => {
    const frame = webFrame({ id: 3, processId: 11 });
    const send = async (command: string) =>
      command === "Target.getTargets" ? { targetInfos: [] } : {};

    await expect(
      sendFrameInputThroughTarget({
        frame,
        send,
        steps: planFrameInputSteps({ kind: "key", key: "Tab" }),
      }),
    ).rejects.toThrow("DevTools target was not found");
    expect(() => planFrameInputSteps({ kind: "key", key: "Control+A" })).toThrow(
      'Key "Control+A" cannot be sent into a cross-origin iframe',
    );
  });
});
