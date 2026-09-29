import type { ActionablePoint } from "./actionability.js";
import type { ClickInputOptions, MouseButton } from "./trusted-input.js";

interface FocusIsolatedInputPage {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

// Events are dispatched to the element itself, so `point` is in the element's
// own document coordinates (an iframe's viewport for a ref inside a frame), and
// they are built from the element's realm so a frame's page code sees its own
// event classes.
export async function dispatchFocusIsolatedClick(
  page: FocusIsolatedInputPage,
  elementExpression: string,
  point: ActionablePoint,
  options: ClickInputOptions = {},
): Promise<boolean> {
  const result = await page.executeJavaScript(
    buildFocusIsolatedClickScript(elementExpression, point, options),
    true,
  );
  return Boolean(result && typeof result === "object" && "ok" in result && result.ok === true);
}

export async function dispatchFocusIsolatedDrag(
  page: FocusIsolatedInputPage,
  sourceExpression: string,
  targetExpression: string,
  sourcePoint: ActionablePoint,
  targetPoint: ActionablePoint,
): Promise<boolean> {
  const result = await page.executeJavaScript(
    buildFocusIsolatedDragScript(sourceExpression, targetExpression, sourcePoint, targetPoint),
    true,
  );
  return Boolean(result && typeof result === "object" && "ok" in result && result.ok === true);
}

function buildFocusIsolatedClickScript(
  elementExpression: string,
  point: ActionablePoint,
  options: ClickInputOptions,
): string {
  const button = options.button ?? "left";
  const modifiers = new Set(options.modifiers ?? []);
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    button: mouseButtonNumber(button),
    altKey: modifiers.has("Alt"),
    ctrlKey: modifiers.has("Control"),
    metaKey: modifiers.has("Meta"),
    shiftKey: modifiers.has("Shift"),
  };
  const activationEvent = button === "right" ? "contextmenu" : "click";
  const clickCount = options.doubleClick ? 2 : 1;

  return String.raw`(() => {
    const __PASEO_FOCUS_ISOLATED_CLICK__ = true;
    const element = ${elementExpression};
    if (!element || element.nodeType !== 1) return { ok: false };
    const view = element.ownerDocument.defaultView || window;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus?.({ preventScroll: true });
    const init = ${JSON.stringify(eventInit)};
    const dispatchPointer = (type, detail) => {
      if (typeof view.PointerEvent === 'function') {
        element.dispatchEvent(new view.PointerEvent(type, { ...init, detail, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
    };
    const dispatchMouse = (type, detail) => {
      element.dispatchEvent(new view.MouseEvent(type, { ...init, detail }));
    };
    for (let detail = 1; detail <= ${clickCount}; detail += 1) {
      dispatchPointer('pointerdown', detail);
      dispatchMouse('mousedown', detail);
      dispatchPointer('pointerup', detail);
      dispatchMouse('mouseup', detail);
      if (${JSON.stringify(button)} === 'left') {
        element.click();
      } else {
        dispatchMouse(${JSON.stringify(activationEvent)}, detail);
      }
    }
    if (${options.doubleClick === true} && ${JSON.stringify(button)} === 'left') {
      dispatchMouse('dblclick', 2);
    }
    return { ok: true };
  })()`;
}

function buildFocusIsolatedDragScript(
  sourceExpression: string,
  targetExpression: string,
  sourcePoint: ActionablePoint,
  targetPoint: ActionablePoint,
): string {
  return String.raw`(() => {
    const __PASEO_FOCUS_ISOLATED_DRAG__ = true;
    const source = ${sourceExpression};
    const target = ${targetExpression};
    if (!source || source.nodeType !== 1 || !target || target.nodeType !== 1) return { ok: false };
    const viewOf = (element) => element.ownerDocument.defaultView || window;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    source.focus?.({ preventScroll: true });
    const sourceView = viewOf(source);
    const dataTransfer = typeof sourceView.DataTransfer === 'function' ? new sourceView.DataTransfer() : undefined;
    const sourceInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: ${sourcePoint.x},
      clientY: ${sourcePoint.y},
      button: 0,
      buttons: 1,
    };
    const targetInit = {
      ...sourceInit,
      clientX: ${targetPoint.x},
      clientY: ${targetPoint.y},
    };
    const dispatchPointer = (element, type, init) => {
      const view = viewOf(element);
      if (typeof view.PointerEvent === 'function') {
        element.dispatchEvent(new view.PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
    };
    const dispatchMouse = (element, type, init) => {
      element.dispatchEvent(new (viewOf(element).MouseEvent)(type, init));
    };
    const dispatchDrag = (element, type, init) => {
      const view = viewOf(element);
      if (typeof view.DragEvent === 'function') {
        element.dispatchEvent(new view.DragEvent(type, { ...init, dataTransfer }));
      }
    };
    dispatchPointer(source, 'pointerdown', sourceInit);
    dispatchMouse(source, 'mousedown', sourceInit);
    dispatchDrag(source, 'dragstart', sourceInit);
    dispatchPointer(target, 'pointermove', targetInit);
    dispatchMouse(target, 'mousemove', targetInit);
    dispatchDrag(target, 'dragenter', targetInit);
    dispatchDrag(target, 'dragover', targetInit);
    dispatchDrag(target, 'drop', targetInit);
    dispatchDrag(source, 'dragend', { ...targetInit, buttons: 0 });
    dispatchPointer(target, 'pointerup', { ...targetInit, buttons: 0 });
    dispatchMouse(target, 'mouseup', { ...targetInit, buttons: 0 });
    return { ok: true };
  })()`;
}

function mouseButtonNumber(button: MouseButton): number {
  if (button === "middle") return 1;
  if (button === "right") return 2;
  return 0;
}
