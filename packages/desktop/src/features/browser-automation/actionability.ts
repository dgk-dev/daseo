import type { SnapshotPage } from "./snapshot-engine.js";

export interface ActionablePoint {
  x: number;
  y: number;
}

export interface ActionableTarget {
  /** Center of the element in the tab's viewport, where trusted CDP input lands. */
  point: ActionablePoint;
  /**
   * The same point in the element's own document: equal to `point` on the top
   * document, relative to the iframe's viewport for a ref inside a frame.
   * Focus-isolated events are dispatched to the element with these coordinates.
   */
  framePoint: ActionablePoint;
  /** The element's rect in its own document. */
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type ActionabilityResult =
  | { ok: true; target: ActionableTarget }
  | { ok: false; reason: "stale_ref" | "timeout"; detail?: string };

const DEFAULT_ACTIONABILITY_TIMEOUT_MS = 5_000;

export async function waitForActionableTarget(input: {
  page: SnapshotPage;
  elementExpression: string;
  editable?: boolean;
  /**
   * The input will be dispatched at the point and land on whatever is hit
   * there (trusted CDP input), not on the element itself (focus-isolated
   * events). Only then does an ancestor hit mean the element is unreachable.
   */
  pointerDelivered?: boolean;
  timeoutMs?: number;
}): Promise<ActionabilityResult> {
  const result = await input.page.executeJavaScript(
    buildActionabilityScript({
      elementExpression: input.elementExpression,
      editable: input.editable === true,
      pointerDelivered: input.pointerDelivered === true,
      timeoutMs: input.timeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS,
    }),
  );
  return readActionabilityResult(result);
}

function readActionabilityResult(value: unknown): ActionabilityResult {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "timeout" };
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && isActionableTarget(record.target)) {
    return { ok: true, target: record.target };
  }
  if (record.ok === false) {
    const reason = record.reason;
    if (reason === "stale_ref" || reason === "timeout") {
      return {
        ok: false,
        reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    }
  }
  return { ok: false, reason: "timeout" };
}

function isActionableTarget(value: unknown): value is ActionableTarget {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isPoint(record.point) && isPoint(record.framePoint) && isRect(record.rect);
}

function isPoint(value: unknown): value is ActionablePoint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isFiniteNumber(record.x) && isFiniteNumber(record.y);
}

function isRect(value: unknown): value is ActionableTarget["rect"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function buildActionabilityScript(input: {
  elementExpression: string;
  editable: boolean;
  pointerDelivered: boolean;
  timeoutMs: number;
}): string {
  return String.raw`(async () => {
    const deadline = performance.now() + ${JSON.stringify(input.timeoutMs)};
    const requiresEditable = ${JSON.stringify(input.editable)};
    const pointerDelivered = ${JSON.stringify(input.pointerDelivered)};

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Electron can suspend requestAnimationFrame while a guest is parked after
    // workspace LRU eviction even though the guest remains CDP-controllable.
    // Timed layout samples keep background browser automation live.
    const waitForLayout = () => sleep(16);
    const nearlyEqual = (a, b) => Math.abs(a - b) < 0.25;
    const sameRect = (a, b) =>
      nearlyEqual(a.x, b.x) &&
      nearlyEqual(a.y, b.y) &&
      nearlyEqual(a.width, b.width) &&
      nearlyEqual(a.height, b.height);
    const rectPayload = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    // A ref inside a same-origin iframe belongs to the frame's document: its
    // layout, styles, and hit tests are in that frame's viewport.
    const viewOf = (element) => element.ownerDocument.defaultView || window;
    const centerPoint = (element, rect) => {
      const view = viewOf(element);
      return {
        x: Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(view.innerWidth - 1, 0)),
        y: Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(view.innerHeight - 1, 0)),
      };
    };
    const outside = (point, rect) =>
      point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom;
    const isDisabled = (element) => {
      if (element.closest?.('[aria-disabled="true"]')) return true;
      if ('disabled' in element && element.disabled) return true;
      const fieldset = element.closest?.('fieldset[disabled]');
      return Boolean(fieldset);
    };
    const isEditable = (element) => {
      if (element.isContentEditable) return true;
      const tag = element.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return !element.readOnly && !isDisabled(element);
      if (tag !== 'input') return false;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return false;
      return !element.readOnly && !isDisabled(element);
    };
    const isVisible = (element, rect) => {
      const style = viewOf(element).getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') !== 0
      );
    };
    // Adapted from vercel-labs/agent-browser's click blocker check (Apache-2.0).
    // A hit on the element's own subtree, or on a label that activates it, is
    // not a blocker. Anything else is described so the agent can dismiss it
    // (usually a dialog, cookie banner, or sticky header).
    const composedParent = (node) =>
      node.parentNode || node.host || (node.getRootNode && node.getRootNode().host) || null;
    const describeBlocker = (hit) => {
      let desc = hit.tagName.toLowerCase();
      if (hit.id) desc += '#' + hit.id;
      else if (typeof hit.className === 'string' && hit.className.trim())
        desc += '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (!hit.id && hit.closest) {
        const anchored = hit.closest('[id]');
        if (anchored && anchored !== hit)
          desc += ' inside ' + anchored.tagName.toLowerCase() + '#' + anchored.id;
      }
      const text = String(hit.innerText || hit.textContent || '').replace(/\s+/g, ' ').trim();
      // Short text names a banner or button; a container's text is just noise.
      if (text && text.length <= 80) desc += ' "' + text + '"';
      return desc;
    };
    const blockerAt = (element, point) => {
      let hit = element.ownerDocument.elementFromPoint(point.x, point.y);
      // Document hit tests retarget to the outermost shadow host; descend so a
      // blocker inside the same component is still reported.
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit) return 'not hit-testable at its click point';
      for (let node = hit; node; node = composedParent(node)) if (node === element) return null;
      // An ancestor at the point is harmless when events are sent to the
      // element itself, or when the element lets pointer events through. For
      // input dispatched at the point it means the element is clipped out of
      // its container, and the click would land on the container while
      // reporting success.
      let hitIsAncestor = false;
      for (let node = composedParent(element); node; node = composedParent(node)) {
        if (node === hit) { hitIsAncestor = true; break; }
      }
      if (hitIsAncestor) {
        return !pointerDelivered || viewOf(element).getComputedStyle(element).pointerEvents === 'none'
          ? null
          : 'clipped or hidden inside <' + describeBlocker(hit) + '>';
      }
      const hitLabel = hit.closest ? hit.closest('label') : null;
      if (hitLabel && (hitLabel.control === element || hitLabel.contains(element))) return null;
      const elementLabel = element.closest ? element.closest('label') : null;
      if (elementLabel && elementLabel.contains(hit)) return null;
      return 'covered by <' + describeBlocker(hit) + '>';
    };
    // The iframe elements between the element's document and this one,
    // innermost first; null once a frame on the way has been removed or
    // navigated, which leaves the element's document without a window.
    const frameChain = (element) => {
      const chain = [];
      let view = element.ownerDocument.defaultView;
      while (view && view !== window) {
        const frame = view.frameElement;
        if (!frame) return null;
        chain.push(frame);
        view = frame.ownerDocument.defaultView;
      }
      return view === window ? chain : null;
    };
    const frameRects = (chain) => chain.map((frame) => frame.getBoundingClientRect());
    // A frame's viewport starts at its content box. The scale covers CSS
    // transforms that resize the frame: offsetWidth ignores them, the
    // bounding rect does not.
    const toParentPoint = (frame, point) => {
      const rect = frame.getBoundingClientRect();
      const style = viewOf(frame).getComputedStyle(frame);
      const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
      const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
      return {
        x: rect.left + (frame.clientLeft + (parseFloat(style.paddingLeft) || 0) + point.x) * scaleX,
        y: rect.top + (frame.clientTop + (parseFloat(style.paddingTop) || 0) + point.y) * scaleY,
      };
    };
    // Carries a frame-local point out to this document's viewport, where
    // trusted CDP input is delivered, checking at every level that the frame
    // is on screen and not covered there, by the same rules as the element.
    const carryToTop = (chain, framePoint) => {
      let point = framePoint;
      for (const frame of chain) {
        point = toParentPoint(frame, point);
        const view = viewOf(frame);
        if (
          outside(point, frame.getBoundingClientRect()) ||
          point.x < 0 || point.y < 0 || point.x > view.innerWidth - 1 || point.y > view.innerHeight - 1
        ) {
          return { blocker: 'outside the visible area' };
        }
        const blocker = blockerAt(frame, point);
        if (blocker) return { blocker: blocker + ' (over its iframe)' };
      }
      return { point };
    };
    const resolveElement = () => (${input.elementExpression});

    let detail = 'not actionable';
    while (performance.now() <= deadline) {
      const element = resolveElement();
      const chain = element && element.isConnected ? frameChain(element) : null;
      if (!chain) {
        return { ok: false, reason: 'stale_ref', detail: 'ref no longer resolves' };
      }

      const rect = element.getBoundingClientRect();
      if (!isVisible(element, rect)) {
        detail = 'not visible';
        await sleep(25);
        continue;
      }
      if (isDisabled(element)) {
        detail = 'disabled';
        await sleep(25);
        continue;
      }
      if (requiresEditable && !isEditable(element)) {
        detail = 'not editable';
        await sleep(25);
        continue;
      }

      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      await waitForLayout();
      const firstRect = element.getBoundingClientRect();
      const firstFrames = frameRects(chain);
      await waitForLayout();
      const secondRect = element.getBoundingClientRect();
      const secondFrames = frameRects(chain);
      // A frame sliding in (a cart drawer) moves the element on screen while
      // its rect inside the frame stays put.
      if (
        !sameRect(firstRect, secondRect) ||
        firstFrames.some((rect, index) => !sameRect(rect, secondFrames[index]))
      ) {
        detail = 'moving';
        continue;
      }

      const framePoint = centerPoint(element, secondRect);
      // centerPoint clamps to the viewport; a clamped point outside the element
      // would otherwise pass the ancestor rule and click the page background.
      const blocker = outside(framePoint, secondRect)
        ? 'outside the visible area'
        : blockerAt(element, framePoint);
      const carried = blocker ? { blocker } : carryToTop(chain, framePoint);
      if (carried.blocker) {
        detail = carried.blocker;
        await sleep(25);
        continue;
      }

      return {
        ok: true,
        target: { point: carried.point, framePoint, rect: rectPayload(secondRect) },
      };
    }

    return { ok: false, reason: 'timeout', detail };
  })()`;
}
