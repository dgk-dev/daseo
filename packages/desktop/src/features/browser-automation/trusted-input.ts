import type { KeyboardInputEvent } from "electron";
import type { ActionablePoint } from "./actionability.js";
import type { CdpCommandSender } from "./cdp-session-queue.js";

export type MouseButton = "left" | "right" | "middle";
export type InputModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface ClickInputOptions {
  button?: MouseButton;
  doubleClick?: boolean;
  modifiers?: InputModifier[];
}

const MODIFIER_MASKS: Record<InputModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export interface IsolatedKeyboardInputEvent extends KeyboardInputEvent {
  type: "char" | "keyDown" | "keyUp";
  // Electron accepts this NativeWebKeyboardEvent flag even though its public
  // TypeScript declarations omit it. It stops an unhandled webview key from
  // being redispatched to the embedder's active DOM element or application menu.
  skipIfUnhandled: true;
}

type KeyboardInputSender = (event: IsolatedKeyboardInputEvent) => void;

const ELECTRON_KEY_CODE_ALIASES: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
};

export async function dispatchTrustedClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  options: ClickInputOptions = {},
): Promise<void> {
  const button = options.button ?? "left";
  const modifiers = modifierMask(options.modifiers);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    modifiers,
  });
  if (options.doubleClick) {
    await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
    await dispatchTrustedMouseClick(send, point, button, modifiers, 2);
    return;
  }
  await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
}

async function dispatchTrustedMouseClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  button: MouseButton,
  modifiers: number,
  clickCount: number,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons: mouseButtonMask(button),
    clickCount,
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
  });
}

export async function dispatchTrustedHover(
  send: CdpCommandSender,
  point: ActionablePoint,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
}

export async function dispatchTrustedDrag(
  send: CdpCommandSender,
  source: ActionablePoint,
  target: ActionablePoint,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: source.x,
    y: source.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: (source.x + target.x) / 2,
    y: (source.y + target.y) / 2,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function dispatchTrustedScroll(
  send: CdpCommandSender,
  point: ActionablePoint,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
}

export function dispatchTrustedKey(send: KeyboardInputSender, key: string): void {
  const keyCode = ELECTRON_KEY_CODE_ALIASES[key] ?? key;
  let character: string | null = null;
  if (key === "Space") {
    character = " ";
  } else if (key.length === 1) {
    character = key;
  }
  send({
    type: "keyDown",
    keyCode,
    skipIfUnhandled: true,
  });
  if (character !== null) {
    send({
      type: "char",
      keyCode: character,
      skipIfUnhandled: true,
    });
  }
  send({
    type: "keyUp",
    keyCode,
    skipIfUnhandled: true,
  });
}

function modifierMask(modifiers: InputModifier[] | undefined): number {
  return (modifiers ?? []).reduce((mask, modifier) => mask | MODIFIER_MASKS[modifier], 0);
}

function mouseButtonMask(button: MouseButton): number {
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  return 1;
}

// Daseo delta 110. Keys for an out-of-process frame go through its DevTools target as
// Input.dispatchKeyEvent, which needs the DOM key, code, and Windows key code that Electron's
// sendInputEvent derives by itself from its key name.
interface CdpKeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const CDP_NAMED_KEYS: Record<string, CdpKeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function cdpKeyDefinition(key: string): CdpKeyDefinition | null {
  const named = CDP_NAMED_KEYS[key];
  if (named) return named;
  const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionKey) {
    return { key, code: key, keyCode: 111 + Number(functionKey[1]) };
  }
  if ([...key].length !== 1) return null;
  if (/^[a-z]$/i.test(key)) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    };
  }
  if (/^\d$/.test(key)) {
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  }
  return { key, code: "", keyCode: 0, text: key };
}

export interface CdpInputStep {
  command: string;
  params: Record<string, unknown>;
}

/** The DevTools commands that put one key into a frame; null for a key name it does not know. */
export function planCdpKeySteps(key: string): CdpInputStep[] | null {
  const definition = cdpKeyDefinition(key);
  if (!definition) return null;
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  const down = definition.text
    ? { type: "keyDown", ...base, text: definition.text, unmodifiedText: definition.text }
    : { type: "rawKeyDown", ...base };
  return [
    { command: "Input.dispatchKeyEvent", params: down },
    { command: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
  ];
}
