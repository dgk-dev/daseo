import { INSERTION_LOG_SOURCE } from "./aria-snapshot-script.js";

// Daseo delta 100. browser_click used to answer "Clicked" the moment its events were dispatched,
// so an agent that looked at once read a dialog still fading in, or a form post still waiting for
// its response, as "nothing happened" and pressed Enter on top of it. The input now reports what it
// caused: a probe armed in the page before the input records DOM changes near the element, dialogs
// and menus that appear, value changes, and submits; main reports navigations, popups, tabs,
// downloads, and page dialogs. The first effect seen ends the wait; only an input that changes
// nothing waits the whole window.

/** How long an input that shows no effect is watched before the result says so. */
export const INPUT_EFFECT_WINDOW_MS = 500;
// The page probe answers by itself at the window's end; this covers a page too busy to answer.
const INPUT_EFFECT_PAGE_GRACE_MS = 250;
const PROBE_KEY = "Symbol.for('paseo.browser-automation.input-probe')";

/** What the page probe saw. Mirrors the object the probe script returns. */
export type PageInputEffect =
  | { kind: "overlay"; role: string; name: string; appearing: boolean }
  | { kind: "state"; attribute: string; value: string | null }
  | { kind: "value"; checked?: boolean }
  | { kind: "content"; near: boolean }
  | { kind: "text" }
  | { kind: "removed" }
  | { kind: "submit-cancelled" }
  | { kind: "submitted" }
  | { kind: "focus" }
  | { kind: "none" };

/** What main saw: the input started something outside the page's own DOM. */
export type HostInputEffect =
  | { kind: "navigation"; url: string; sameDocument: boolean }
  | {
      kind: "opened";
      type: "popup_opened" | "tab_opened" | "download_started";
      url?: string;
      browserId?: string;
    }
  | { kind: "page-dialog"; type: string };

export type InputEffect = PageInputEffect | HostInputEffect;

export interface InputEffectPage {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** Subscriptions to the host-side signals of one tab; each returns an unsubscribe. */
export interface InputEffectHostSignals {
  onNavigationStarted?(listener: (url: string, sameDocument: boolean) => void): () => void;
  onTargetOpened?(
    listener: (event: Extract<HostInputEffect, { kind: "opened" }>) => void,
  ): () => void;
  onPageDialog?(listener: (type: string) => void): () => void;
}

export type InputVerb = "click" | "key";

/**
 * Arms the probe, runs `dispatch`, and resolves with the first effect seen, or with the probe's
 * verdict after INPUT_EFFECT_WINDOW_MS. Resolves `null` when the probe could not be armed (the
 * element is gone); the input is still dispatched then.
 */
export async function observeInputEffect(input: {
  page: InputEffectPage;
  elementExpression: string;
  signals: InputEffectHostSignals;
  dispatch: () => Promise<boolean>;
  windowMs?: number;
}): Promise<{ dispatched: boolean; effect: InputEffect | null }> {
  const windowMs = input.windowMs ?? INPUT_EFFECT_WINDOW_MS;
  const probeId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let armed = false;
  try {
    armed =
      (await input.page.executeJavaScript(
        buildInputProbeArmScript(input.elementExpression, probeId),
      )) === true;
  } catch {
    armed = false;
  }

  let settle: (effect: InputEffect) => void = () => {};
  const hostEffect = new Promise<InputEffect>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = [
    input.signals.onNavigationStarted?.((url, sameDocument) =>
      settle({ kind: "navigation", url, sameDocument }),
    ),
    input.signals.onTargetOpened?.((event) => settle(event)),
    input.signals.onPageDialog?.((type) => settle({ kind: "page-dialog", type })),
  ];
  try {
    const dispatched = await input.dispatch();
    if (!dispatched || !armed) {
      return { dispatched, effect: null };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pageEffect = input.page
      .executeJavaScript(buildInputProbeWaitScript(probeId, windowMs))
      .then(readPageInputEffect, () => null);
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), windowMs + INPUT_EFFECT_PAGE_GRACE_MS);
    });
    const effect = await Promise.race([
      hostEffect,
      pageEffect.then((value) => value ?? hostEffect),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    // Not awaited: the page may be gone or blocked by a dialog, and the probe stops by itself at
    // the window's end.
    void input.page.executeJavaScript(buildInputProbeDisposeScript(probeId)).catch(() => {});
    return { dispatched, effect: effect ?? { kind: "none" } };
  } finally {
    for (const stop of unsubscribe) stop?.();
  }
}

/** One line for the tool result, without a trailing period. */
export function describeInputEffect(effect: InputEffect, verb: InputVerb): string {
  switch (effect.kind) {
    case "navigation":
    case "opened":
    case "page-dialog":
      return describeHostEffect(effect);
    case "overlay":
    case "state":
    case "value":
      return describeChange(effect);
    default:
      return describeQuietEffect(effect, verb);
  }
}

function describeHostEffect(effect: HostInputEffect): string {
  if (effect.kind === "navigation") {
    return effect.sameDocument
      ? `the page URL changed to ${effect.url}`
      : `navigation started to ${effect.url}`;
  }
  if (effect.kind === "page-dialog") return `the page opened a ${effect.type} dialog`;
  const at = effect.url ? ` at ${effect.url}` : "";
  if (effect.type === "download_started") return "a download started";
  if (effect.type === "tab_opened") return `opened a new tab${at}`;
  return effect.browserId ? `opened popup ${effect.browserId}${at}` : `opened a popup${at}`;
}

function describeChange(
  effect: Extract<PageInputEffect, { kind: "overlay" | "state" | "value" }>,
): string {
  if (effect.kind === "overlay") {
    const label = `${effect.role}${effect.name ? ` "${effect.name}"` : ""}`;
    return effect.appearing
      ? `a ${label} appeared and is still fading in (find and snapshot mark it appearing=true)`
      : `a ${label} appeared`;
  }
  if (effect.kind === "value") {
    return effect.checked === undefined ? "the value changed" : `checked is now ${effect.checked}`;
  }
  if (effect.value === null) return `${effect.attribute} was removed from the element`;
  if (effect.value === "") return `${effect.attribute} was set on the element`;
  return `${effect.attribute} changed to ${effect.value}`;
}

const QUIET_EFFECT_TEXT: Record<
  Exclude<PageInputEffect["kind"], "overlay" | "state" | "value">,
  (windowText: string, what: string) => string
> = {
  content: () => "content changed near the element",
  text: () => "text changed near the element",
  removed: () => "the element was removed from the page",
  "submit-cancelled": (windowText) =>
    `the page cancelled the form submit and nothing else changed within ${windowText}`,
  submitted: (windowText) =>
    `the form was submitted but no navigation started within ${windowText}`,
  focus: (windowText, what) =>
    `no change seen within ${windowText}, only focus moved to the element; ${what} may not have activated it`,
  none: (windowText) => `no change seen within ${windowText}`,
};

function describeQuietEffect(
  effect: Exclude<PageInputEffect, { kind: "overlay" | "state" | "value" }>,
  verb: InputVerb,
): string {
  if (effect.kind === "content" && !effect.near) return "new content appeared on the page";
  return QUIET_EFFECT_TEXT[effect.kind](
    `${INPUT_EFFECT_WINDOW_MS} ms`,
    verb === "click" ? "the click" : "the key",
  );
}

function readPageInputEffect(value: unknown): PageInputEffect | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  const kind = (value as { kind: unknown }).kind;
  if (typeof kind !== "string" || kind === "lost") return null;
  return value as PageInputEffect;
}

// The probe lives on a registered symbol, so the page's own enumeration does not see it. It watches
// the element's document (and the top document when the element is in a same-origin frame), keeps
// the first meaningful change, and answers `wait` at once when one is already known.
export function buildInputProbeArmScript(elementExpression: string, probeId: string): string {
  return String.raw`(() => {
    ${INSERTION_LOG_SOURCE}
    ensureInsertionLog();
    const element = ${elementExpression};
    if (!element || element.nodeType !== 1) return false;
    const previous = window[${PROBE_KEY}];
    if (previous && typeof previous.dispose === 'function') previous.dispose();
    const doc = element.ownerDocument;
    const view = doc.defaultView || window;
    const NEAR_DEPTH = 3;
    const OVERLAYS = '[role=dialog],[role=alertdialog],dialog[open],[role=menu],[role=listbox],[role=tooltip]';
    const STATE_ATTRIBUTES = new Set(['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected',
      'aria-current', 'aria-busy', 'disabled', 'checked', 'open', 'value', 'data-state']);
    const SILENT_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
    let near = element;
    for (let depth = 0; depth < NEAR_DEPTH && near.parentElement; depth += 1) near = near.parentElement;

    const deepActive = (root) => {
      let active = root.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    const styleOf = (node) => (node.ownerDocument.defaultView || window).getComputedStyle(node);
    const rendered = (node) => {
      const style = styleOf(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const rendersSomething = (node) => {
      if (SILENT_TAGS.has(node.tagName)) return false;
      if (rendered(node)) return true;
      const descendants = node.querySelectorAll('*');
      for (let index = 0; index < descendants.length && index < 40; index += 1) {
        if (rendered(descendants[index])) return true;
      }
      return false;
    };
    const fading = (node, stop) => {
      for (let current = node, depth = 0; current && depth < 12; current = current.parentElement, depth += 1) {
        if (Number(styleOf(current).opacity) < 1) return true;
        const animations = typeof current.getAnimations === 'function' ? current.getAnimations() : [];
        if (animations.some((animation) => animation.playState === 'running' || animation.pending)) return true;
        if (current === stop) break;
      }
      return false;
    };
    const overlayName = (node) => String(node.getAttribute('aria-label') ||
      (node.getAttribute('aria-labelledby') && node.ownerDocument.getElementById(node.getAttribute('aria-labelledby'))?.textContent) ||
      (node.querySelector('h1,h2,h3,h4,h5,h6')?.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const overlayRole = (node) => node.getAttribute('role') || 'dialog';
    const visibleOverlays = (root) => Array.from(root.querySelectorAll(OVERLAYS)).filter(rendered);
    const docs = doc === document ? [doc] : [doc, document];
    const baseline = new Set(docs.flatMap(visibleOverlays));
    const baselineActive = deepActive(doc);

    const probe = { id: ${JSON.stringify(probeId)}, effect: null, fallback: null, waiters: [], observers: [], listeners: [] };
    const settle = (effect) => {
      if (probe.effect) return;
      probe.effect = effect;
      for (const resolve of probe.waiters.splice(0)) resolve(effect);
      probe.stop();
    };
    const overlayEffect = (node, stop) => ({ kind: 'overlay', role: overlayRole(node), name: overlayName(node), appearing: fading(node, stop) });
    const checkOverlays = () => {
      for (const root of docs) {
        for (const overlay of visibleOverlays(root)) {
          if (!baseline.has(overlay)) return overlayEffect(overlay, root.body);
        }
      }
      return null;
    };
    const classify = (records) => {
      let found = checkOverlays();
      if (found) return found;
      for (const record of records) {
        const target = record.target;
        if (record.type === 'attributes') {
          const name = record.attributeName;
          if (name === 'open' && target.nodeType === 1 && (target.tagName === 'DIALOG' || target.tagName === 'DETAILS')) {
            return { kind: 'state', attribute: 'open', value: target.getAttribute('open') };
          }
          if (STATE_ATTRIBUTES.has(name) && (target === element || near.contains(target))) {
            const value = target.getAttribute(name);
            if (value !== record.oldValue) found = found || { kind: 'state', attribute: name, value };
          }
          continue;
        }
        if (record.type === 'characterData') {
          if (near.contains(target)) found = found || { kind: 'text' };
          continue;
        }
        if (!element.isConnected) return { kind: 'removed' };
        const isNear = near.contains(target) || target === near;
        const atTop = target === target.ownerDocument.body || target === target.ownerDocument.documentElement ||
          target.parentElement === target.ownerDocument.body;
        for (const node of record.addedNodes) {
          if (node.nodeType === 3 && isNear && String(node.textContent).trim()) found = found || { kind: 'text' };
          if (node.nodeType !== 1 || !node.isConnected) continue;
          const overlay = node.matches(OVERLAYS) ? node : node.querySelector(OVERLAYS);
          if (overlay && (rendered(overlay) || rendersSomething(overlay))) return overlayEffect(overlay, node);
          if ((isNear || atTop) && rendersSomething(node)) found = found || { kind: 'content', near: isNear };
        }
        if (isNear && record.removedNodes.length > 0) {
          for (const node of record.removedNodes) {
            if (node.nodeType === 1 && !SILENT_TAGS.has(node.tagName)) found = found || { kind: 'content', near: true };
            if (node.nodeType === 3 && String(node.textContent).trim()) found = found || { kind: 'text' };
          }
        }
      }
      return found;
    };

    for (const root of docs) {
      const observer = new MutationObserver((records) => {
        const effect = classify(records);
        if (effect) settle(effect);
      });
      observer.observe(root.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
      probe.observers.push(observer);
    }
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler, true);
      probe.listeners.push(() => target.removeEventListener(type, handler, true));
    };
    const onValue = (event) => {
      const changed = event.target;
      if (!changed || changed.nodeType !== 1 || !(changed === element || near.contains(changed) || element.contains(changed))) return;
      const kind = String(changed.getAttribute('type') || '').toLowerCase();
      settle(kind === 'checkbox' || kind === 'radio' ? { kind: 'value', checked: Boolean(changed.checked) } : { kind: 'value' });
    };
    listen(view, 'input', onValue);
    listen(view, 'change', onValue);
    listen(view, 'submit', (event) => {
      // Decided after every handler ran: a page handler registered after this one may cancel it.
      setTimeout(() => {
        if (probe.effect) return;
        probe.fallback = event.defaultPrevented ? { kind: 'submit-cancelled' } : { kind: 'submitted' };
      }, 0);
    });
    // stop ends the watching but keeps the verdict readable for the wait script; dispose also
    // removes the probe (a new probe, or main once it has its answer).
    probe.stop = () => {
      for (const observer of probe.observers.splice(0)) observer.disconnect();
      for (const stop of probe.listeners.splice(0)) stop();
    };
    probe.dispose = () => {
      probe.stop();
      if (window[${PROBE_KEY}] === probe) {
        try { delete window[${PROBE_KEY}]; } catch {}
      }
    };
    probe.wait = (windowMs) => new Promise((resolve) => {
      if (probe.effect) {
        resolve(probe.effect);
        return;
      }
      probe.waiters.push(resolve);
      setTimeout(() => {
        if (probe.effect) return;
        const late = checkOverlays();
        if (late) {
          settle(late);
          return;
        }
        if (probe.fallback) {
          settle(probe.fallback);
          return;
        }
        if (!element.isConnected) {
          settle({ kind: 'removed' });
          return;
        }
        settle(deepActive(doc) !== baselineActive ? { kind: 'focus' } : { kind: 'none' });
      }, windowMs);
    });
    Object.defineProperty(window, ${PROBE_KEY}, { configurable: true, enumerable: false, value: probe });
    return true;
  })()`;
}

export function buildInputProbeWaitScript(probeId: string, windowMs: number): string {
  return String.raw`(() => {
    const probe = window[${PROBE_KEY}];
    if (!probe || probe.id !== ${JSON.stringify(probeId)}) {
      return { kind: 'lost' };
    }
    if (probe.effect) return probe.effect;
    return probe.wait(${Math.max(0, Math.round(windowMs))});
  })()`;
}

function buildInputProbeDisposeScript(probeId: string): string {
  return String.raw`(() => {
    const probe = window[${PROBE_KEY}];
    if (probe && probe.id === ${JSON.stringify(probeId)} && typeof probe.dispose === 'function') probe.dispose();
    return true;
  })()`;
}
