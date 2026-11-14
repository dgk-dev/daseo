import { randomUUID } from "node:crypto";
import type { FrameInput, TabFrame } from "./frames.js";
import { planCdpKeySteps, type CdpInputStep } from "./trusted-input.js";

// Daseo delta 110. The tab's frames as the automation sees them (frames.ts), read from Electron's
// WebFrameMain tree, and input for a frame in another renderer process.

/** The part of Electron's WebFrameMain the automation uses. */
export interface WebFrameLike {
  readonly frameTreeNodeId: number;
  readonly processId: number;
  readonly url: string;
  readonly parent: WebFrameLike | null;
  readonly detached?: boolean;
  readonly framesInSubtree: WebFrameLike[];
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface FrameScriptHooks {
  /** Called before each frame script; `userGesture` marks an agent's input. */
  beforeScript(userGesture: boolean): void;
}

/**
 * Every frame below `mainFrame`. A frame's script runs in the frame that holds its id when the
 * script is sent, so a frame that swapped renderer processes after a navigation still answers.
 */
export function listTabFrames(
  readMainFrame: () => WebFrameLike,
  hooks: FrameScriptHooks,
): TabFrame[] {
  const mainFrame = readMainFrame();
  const mainId = mainFrame.frameTreeNodeId;
  return mainFrame.framesInSubtree
    .filter((frame) => frame.frameTreeNodeId !== mainId && frame.detached !== true)
    .map((frame) => {
      const id = frame.frameTreeNodeId;
      const parent = frame.parent;
      return {
        id,
        parentId: parent && parent.frameTreeNodeId !== mainId ? parent.frameTreeNodeId : null,
        outOfProcess: parent ? frame.processId !== parent.processId : false,
        url: frame.url,
        executeJavaScript: (code: string, userGesture?: boolean) => {
          const current = findWebFrame(readMainFrame(), id);
          if (!current) {
            return Promise.reject(new Error("The iframe is gone."));
          }
          hooks.beforeScript(userGesture === true);
          // WebFrameMain rejects an undefined userGesture.
          return current.executeJavaScript(code, userGesture === true);
        },
      };
    });
}

export function findWebFrame(mainFrame: WebFrameLike, frameId: number): WebFrameLike | null {
  return (
    mainFrame.framesInSubtree.find(
      (frame) => frame.frameTreeNodeId === frameId && frame.detached !== true,
    ) ?? null
  );
}

export type DebuggerSend = (
  command: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

const FRAME_KEY = "Symbol.for('paseo.browser-automation.frame-key')";

/** The DevTools commands for one text or key input; throws for a key name it does not know. */
export function planFrameInputSteps(input: FrameInput): CdpInputStep[] {
  if (input.kind === "text") {
    return [{ command: "Input.insertText", params: { text: input.text } }];
  }
  const steps = planCdpKeySteps(input.key);
  if (!steps) {
    throw new Error(
      `Key "${input.key}" cannot be sent into a cross-origin iframe. Use a single character or one of Enter, Tab, Backspace, Escape, Delete, Space, the arrow keys, Home, End, PageUp, PageDown, F1-F12.`,
    );
  }
  return steps;
}

/**
 * Sends the input through the DevTools target of `frame`, a frame in another renderer process
 * (a local root). Targets are browser-wide, so the right one is told apart by a key the frame's own
 * script set a moment before, not by its URL, which another tab can share.
 */
export async function sendFrameInputThroughTarget(input: {
  frame: WebFrameLike;
  send: DebuggerSend;
  steps: CdpInputStep[];
}): Promise<void> {
  const { frame, send } = input;
  const key = randomUUID();
  await frame.executeJavaScript(
    `(() => { Object.defineProperty(window, ${FRAME_KEY}, { configurable: true, enumerable: false, value: ${JSON.stringify(key)} }); return true; })()`,
    false,
  );
  const { targetInfos } = (await send("Target.getTargets")) as { targetInfos?: TargetInfo[] };
  const iframes = (targetInfos ?? []).filter((target) => target.type === "iframe");
  // The frame's URL first: usually one candidate, checked with one attach.
  const candidates = [
    ...iframes.filter((target) => target.url === frame.url),
    ...iframes.filter((target) => target.url !== frame.url),
  ];
  for (const candidate of candidates) {
    const { sessionId } = (await send("Target.attachToTarget", {
      targetId: candidate.targetId,
      flatten: true,
    })) as { sessionId: string };
    try {
      const evaluated = (await send(
        "Runtime.evaluate",
        { expression: `window[${FRAME_KEY}]`, returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown } };
      if (evaluated.result?.value === key) {
        for (const step of input.steps) {
          await send(step.command, step.params, sessionId);
        }
        return;
      }
    } finally {
      await send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
  throw new Error("The iframe's DevTools target was not found.");
}
