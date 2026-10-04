export const ARIA_SNAPSHOT_SCRIPT_MARKER = "__PASEO_ARIA_SNAPSHOT__";
export const ARIA_FIND_SCRIPT_MARKER = "__PASEO_ARIA_FIND__";

// Adapted from Playwright's injected ARIA snapshot model.
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
//
// Role, name, visibility, state, and ref numbering shared by the snapshot and
// browser_find, so a find match and a snapshot line agree on the same element.
export const ARIA_SHARED_SOURCE = String.raw`
  const ACTIONABLE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem'
  ]);

  function normalizeText(value) {
    return String(value || '').replace(/[\u200b\u00ad]/g, '').replace(/[\r\n\s\t]+/g, ' ').trim();
  }

  // Same-origin iframe content is walked from this document, so its nodes come
  // from another realm: instanceof checks against this window's Element fail
  // for them, and styles and layout belong to the frame's own window.
  function isElement(node) {
    return Boolean(node) && node.nodeType === 1;
  }

  function isHtmlElement(node) {
    return isElement(node) && node.namespaceURI === 'http://www.w3.org/1999/xhtml';
  }

  function styleOf(element) {
    const view = element.ownerDocument && element.ownerDocument.defaultView;
    return (view || window).getComputedStyle(element);
  }

  // The frame's document when this script may reach into it: contentDocument is
  // null for cross-origin and sandboxed frames, exactly the frames the page's own
  // script cannot touch either. A document that is still parsing is skipped.
  function frameDocument(element) {
    let doc = null;
    try {
      doc = element.contentDocument;
    } catch {
      return null;
    }
    if (!doc || !doc.defaultView || doc.readyState === 'loading') return null;
    return doc;
  }

  function isFrameElement(element) {
    const tag = element.tagName.toLowerCase();
    return tag === 'iframe' || tag === 'frame';
  }

  function visibilityFor(element) {
    if (!isElement(element)) return false;
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? 'box' : 'boxless';
  }

  function explicitRole(element) {
    const role = element.getAttribute('role');
    if (!role || role === 'presentation' || role === 'none') return null;
    return role.split(/\s+/)[0].toLowerCase();
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (element.isContentEditable === true) return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'section') return element.getAttribute('aria-label') ? 'region' : null;
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'iframe' || tag === 'frame') return 'iframe';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    return null;
  }

  function roleFor(element) {
    return explicitRole(element) || implicitRole(element);
  }

  // Label and aria-labelledby targets live in the element's own tree, which
  // is a shadow root for web components.
  function treeRootOf(element) {
    const root = element.getRootNode ? element.getRootNode() : element.ownerDocument;
    return root && typeof root.querySelector === 'function' ? root : element.ownerDocument;
  }

  function labelText(element) {
    if (!isHtmlElement(element)) return '';
    if (element.id) {
      const escapedId = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape(element.id)
        : String(element.id).replace(/"/g, '\\"');
      const label = treeRootOf(element).querySelector('label[for="' + escapedId + '"]');
      if (label) return normalizeText(label.textContent);
    }
    const closestLabel = element.closest('label');
    return closestLabel ? normalizeText(closestLabel.textContent) : '';
  }

  function nameFor(element, role) {
    const tag = element.tagName.toLowerCase();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = treeRootOf(element);
      const text = labelledBy.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : element.ownerDocument.getElementById(id))?.textContent || '').join(' ');
      const normalized = normalizeText(text);
      if (normalized) return normalized;
    }
    const pieces = [
      element.getAttribute('aria-label'),
      labelText(element),
      element.getAttribute('alt'),
      element.getAttribute('title'),
      tag === 'input' || tag === 'textarea' ? element.getAttribute('placeholder') : null,
      tag === 'input' || tag === 'textarea' ? element.value : null,
      role === 'button' || role === 'link' || role === 'heading' || ACTIONABLE_ROLES.has(role)
        ? element.textContent
        : null
    ];
    return normalizeText(pieces.find((piece) => normalizeText(piece).length > 0) || '');
  }

  function fingerprintNameFor(element, role, name) {
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return name;
    const mutableValue = normalizeText(element.value);
    if (!mutableValue || name !== mutableValue) return name;
    return '';
  }

  function inheritedDisabled(element) {
    if (!isElement(element)) return false;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return true;
    if (element.closest('fieldset[disabled]')) return true;
    return element.closest('[aria-disabled="true"]') !== null;
  }

  function isActionable(element, role) {
    if (!role || !ACTIONABLE_ROLES.has(role)) return false;
    if (visibilityFor(element) !== 'box') return false;
    if (inheritedDisabled(element)) return false;
    return true;
  }

  function fingerprintFor(element, role, name) {
    return {
      role,
      name: fingerprintNameFor(element, role, name),
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      ariaLabel: element.getAttribute('aria-label') || ''
    };
  }

  function fingerprintMatches(element, fingerprint) {
    const role = roleFor(element) || 'generic';
    const name = nameFor(element, role);
    const current = fingerprintFor(element, role, name);
    return current.role === fingerprint.role &&
      current.name === fingerprint.name &&
      current.tagName === fingerprint.tagName &&
      current.type === fingerprint.type &&
      current.ariaLabel === fingerprint.ariaLabel;
  }

  // Ref numbers stay attached to their element for the life of the document
  // (Playwright MCP and agent-browser do the same). Renumbering from @e1 on
  // every snapshot let a ref read from an older snapshot land on a different
  // element that happened to share the old number and fingerprint, such as the
  // next row's "Delete" button. The resolver itself is rebuilt each snapshot.
  // Elements inside same-origin iframes share this registry; a frame that
  // navigated or was removed leaves its old document without a window.
  // keepRefs (browser_find) adds to the refs of the latest snapshot instead of
  // starting a new set, so the snapshot's refs keep resolving.
  function ensureRuntime(keepRefs) {
    const previous = window.__PASEO_BROWSER_AUTOMATION__;
    if (keepRefs && previous && previous.refs instanceof Map && previous.numbering &&
      previous.numbering.refByElement instanceof WeakMap) {
      return previous;
    }
    const numbering = previous && previous.numbering && previous.numbering.refByElement instanceof WeakMap
      ? previous.numbering
      : { refByElement: new WeakMap(), nextRef: 1 };
    const runtime = {
      refs: new Map(),
      numbering,
      resolve(ref, fingerprint) {
        const element = this.refs.get(ref);
        if (!element || !element.isConnected || !element.ownerDocument.defaultView || !fingerprintMatches(element, fingerprint)) {
          return { ok: false, reason: 'stale_ref' };
        }
        return { ok: true, element };
      }
    };
    Object.defineProperty(window, '__PASEO_BROWSER_AUTOMATION__', {
      configurable: true,
      enumerable: false,
      value: runtime
    });
    return runtime;
  }

  function stateAttributes(element, role) {
    const attrs = [];
    if (role === 'heading') {
      const tag = element.tagName.toLowerCase();
      const level = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : Number(element.getAttribute('aria-level') || 0);
      if (level) attrs.push('level=' + level);
    }
    if (element.matches?.('input[type="checkbox"], input[type="radio"]')) {
      attrs.push('checked=' + (element.checked ? 'true' : 'false'));
    }
    if (element.getAttribute('aria-checked')) attrs.push('checked=' + element.getAttribute('aria-checked'));
    if (element.getAttribute('aria-expanded')) attrs.push('expanded=' + element.getAttribute('aria-expanded'));
    if (element.getAttribute('aria-pressed')) attrs.push('pressed=' + element.getAttribute('aria-pressed'));
    if (element.getAttribute('aria-selected')) attrs.push('selected=' + element.getAttribute('aria-selected'));
    // Disabled controls get no ref (isActionable); the attribute says why.
    if (ACTIONABLE_ROLES.has(role) && inheritedDisabled(element)) attrs.push('disabled=true');
    if (element === focusedElement) attrs.push('focused=true');
    return attrs;
  }

  // The element keyboard input goes to: document.activeElement, followed into
  // open shadow roots and same-origin iframes, whose host element is what the
  // outer document reports as active.
  function deepActiveElement() {
    let active = document.activeElement;
    while (active) {
      if (active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      const inner = isFrameElement(active) ? frameDocument(active) : null;
      const innerActive = inner && inner.activeElement;
      if (innerActive && innerActive !== inner.body && innerActive !== inner.documentElement) {
        active = innerActive;
        continue;
      }
      break;
    }
    if (!active) return null;
    const owner = active.ownerDocument;
    return active === owner.body || active === owner.documentElement ? null : active;
  }

  // Rendered children, following Playwright's ariaSnapshot traversal: a slot
  // renders its assigned light-DOM nodes, and a shadow host renders its
  // unslotted light children followed by its open shadow tree.
  // A same-origin iframe renders its document's body in place of its own
  // (fallback) children; a cross-origin one renders nothing.
  function renderedChildren(element) {
    if (isFrameElement(element)) {
      const doc = frameDocument(element);
      const body = doc && (doc.body || doc.documentElement);
      return body ? renderedChildren(body) : [];
    }
    if (element.nodeName === 'SLOT' && typeof element.assignedNodes === 'function') {
      const assigned = element.assignedNodes();
      if (assigned.length) return assigned;
    }
    const children = [];
    for (const child of Array.from(element.childNodes)) {
      if (!child.assignedSlot) children.push(child);
    }
    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.childNodes)) children.push(child);
    }
    return children;
  }

  // Assigns the element's document-lifetime ref and registers it for resolving.
  function refFor(runtime, element) {
    let ref = runtime.numbering.refByElement.get(element);
    if (!ref) {
      ref = '@e' + runtime.numbering.nextRef;
      runtime.numbering.nextRef += 1;
      runtime.numbering.refByElement.set(element, ref);
    }
    runtime.refs.set(ref, element);
    return ref;
  }
`;

export const ARIA_SNAPSHOT_SCRIPT = String.raw`(() => {
  const MARKER = ${JSON.stringify(ARIA_SNAPSHOT_SCRIPT_MARKER)};
  const MAX_NODES = 1500;
  const MAX_REFS = 500;
  const MAX_TEXT_LENGTH = 80000;
${ARIA_SHARED_SOURCE}
  // leadingSpace/trailingSpace record whitespace the page had at the edges of the
  // run before normalizeText trimmed it, so the renderer joins inline runs with a
  // space only where the page has one ("<span>T</span><span>h</span>" is "Th").
  function textNode(text, leadingSpace, trailingSpace) {
    const node = { kind: 'text', text };
    if (leadingSpace) node.leadingSpace = true;
    if (trailingSpace) node.trailingSpace = true;
    return node;
  }

  function elementNode(element, role, name) {
    return {
      kind: 'role',
      role: role || 'generic',
      name,
      tagName: element.tagName.toLowerCase(),
      attributes: stateAttributes(element, role),
      children: []
    };
  }

  let nodeCount = 0;
  let refCount = 0;
  let iframeCount = 0;
  let maxDepth = 0;
  let truncated = false;
  let textBudget = MAX_TEXT_LENGTH;
  const runtime = ensureRuntime(false);
  const focusedElement = deepActiveElement();

  function countNode(depth) {
    if (nodeCount >= MAX_NODES) {
      truncated = true;
      return false;
    }
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    return true;
  }

  function cappedText(text) {
    if (text.length <= textBudget) {
      textBudget -= text.length;
      return text;
    }
    truncated = true;
    const capped = text.slice(0, Math.max(0, textBudget));
    textBudget = 0;
    return capped;
  }

  function visitNode(domNode, depth) {
    if (!countNode(depth)) return null;
    if (domNode.nodeType === 3) {
      const raw = String(domNode.textContent || '').replace(/[\u200b\u00ad]/g, '');
      const text = cappedText(normalizeText(raw));
      // A whitespace-only run renders nothing but still separates its neighbours.
      if (!text) return /\s/.test(raw) ? textNode('', true, true) : null;
      return textNode(text, /^\s/.test(raw), /\s$/.test(raw));
    }
    if (!isElement(domNode)) return null;
    const visibility = visibilityFor(domNode);
    if (!visibility) return null;
    if (domNode.getAttribute('aria-hidden') === 'true') return null;

    const role = roleFor(domNode);
    const name = role ? nameFor(domNode, role) : '';
    const children = [];
    for (const child of renderedChildren(domNode)) {
      const childSnapshot = visitNode(child, depth + 1);
      if (childSnapshot) children.push(childSnapshot);
      if (truncated) break;
    }

    const isFrame = isFrameElement(domNode);
    if (isFrame) {
      iframeCount += 1;
    }

    if (visibility === 'boxless') {
      return children.length > 0 ? { kind: 'group', children } : null;
    }
    if (!role && children.length === 0) return null;
    const snapshotNode = role
      ? elementNode(domNode, role, name)
      : { kind: 'group', block: !/^inline/.test(styleOf(domNode).display), children: [] };
    // Say why a frame has no children and where its content comes from; the
    // agent can open a cross-origin frame's URL in its own tab.
    if (isFrame && role && !frameDocument(domNode)) {
      let reachable = false;
      try {
        reachable = Boolean(domNode.contentDocument);
      } catch {}
      snapshotNode.attributes.push(reachable ? 'loading=true' : 'cross-origin=true');
      if (domNode.src) snapshotNode.attributes.push('src=' + String(domNode.src).slice(0, 200));
    }
    snapshotNode.children = children;
    if (role && isActionable(domNode, role) && refCount < MAX_REFS) {
      const ref = refFor(runtime, domNode);
      const fingerprint = fingerprintFor(domNode, role, name);
      refCount += 1;
      snapshotNode.ref = ref;
      snapshotNode.fingerprint = fingerprint;
    } else if (role && isActionable(domNode, role)) {
      truncated = true;
    }
    return snapshotNode;
  }

  const root = {
    kind: 'role',
    role: 'document',
    name: normalizeText(document.title),
    tagName: 'document',
    attributes: [],
    children: []
  };
  for (const child of renderedChildren(document.body || document.documentElement)) {
    const childSnapshot = visitNode(child, 1);
    if (childSnapshot) root.children.push(childSnapshot);
    if (truncated) break;
  }

  return JSON.stringify({
    marker: MARKER,
    root,
    refs: Array.from(runtime.refs.entries()).map(([ref, element]) => {
      const role = roleFor(element) || 'generic';
      const name = nameFor(element, role);
      return { ref, fingerprint: fingerprintFor(element, role, name) };
    }),
    truncated,
    stats: { nodeCount, refCount, textLength: 0, iframeCount, maxDepth }
  });
})()`;

export interface AriaFindQuery {
  role: string | null;
  /** Plain name to match; null with a pattern or without a name. */
  name: string | null;
  exact: boolean;
  pattern: { source: string; flags: string } | null;
  limit: number;
}

// browser_find: the snapshot's walk without its node and ref caps, keeping
// only elements whose role and accessible name match. Hidden elements never
// match, as in Playwright's getByRole; actionable matches get the element's
// document-lifetime ref.
export function buildAriaFindScript(query: AriaFindQuery): string {
  return String.raw`(() => {
  const MARKER = ${JSON.stringify(ARIA_FIND_SCRIPT_MARKER)};
  const QUERY = ${JSON.stringify(query)};
  const MAX_TEXT = 200;
${ARIA_SHARED_SOURCE}
  const runtime = ensureRuntime(true);
  const focusedElement = deepActiveElement();
  const LANDMARK_ROLES = new Set([
    'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
    'dialog', 'alertdialog'
  ]);

  const roleQuery = QUERY.role ? QUERY.role.toLowerCase() : null;
  let nameMatches = () => true;
  if (QUERY.pattern) {
    const pattern = new RegExp(QUERY.pattern.source, QUERY.pattern.flags);
    nameMatches = (name) => pattern.test(name);
  } else if (QUERY.name !== null) {
    const needle = normalizeText(QUERY.name);
    const lowered = needle.toLowerCase();
    nameMatches = QUERY.exact ? (name) => name === needle : (name) => name.toLowerCase().includes(lowered);
  }

  // Up through shadow hosts and frame elements, so a button inside a web
  // component or a same-origin frame still finds the landmark around it.
  function parentAcrossBoundaries(element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode ? element.getRootNode() : null;
    if (root && root.host) return root.host;
    try {
      const view = element.ownerDocument && element.ownerDocument.defaultView;
      return view && view.frameElement ? view.frameElement : null;
    } catch {
      return null;
    }
  }

  function landmarkRoleFor(element) {
    const role = roleFor(element);
    if (role) return LANDMARK_ROLES.has(role) ? role : null;
    const tag = element.tagName.toLowerCase();
    if (tag === 'aside') return 'complementary';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'search') return 'search';
    if (tag === 'form' && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'))) return 'form';
    return null;
  }

  function landmarkFor(element) {
    for (let current = parentAcrossBoundaries(element); current; current = parentAcrossBoundaries(current)) {
      const role = landmarkRoleFor(current);
      if (!role) continue;
      const name = nameFor(current, role);
      return name ? role + ' ' + JSON.stringify(name) : role;
    }
    return null;
  }

  function describeMatch(element, role, name) {
    const match = { role, name, states: stateAttributes(element, role) };
    if (isActionable(element, role)) {
      match.ref = refFor(runtime, element);
      match.fingerprint = fingerprintFor(element, role, name);
    } else {
      const text = normalizeText(element.textContent);
      if (text && text !== name) match.text = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
    }
    const landmark = landmarkFor(element);
    if (landmark) match.landmark = landmark;
    return match;
  }

  const matches = [];
  let total = 0;
  const stack = renderedChildren(document.body || document.documentElement).reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node)) continue;
    const visibility = visibilityFor(node);
    if (!visibility || node.getAttribute('aria-hidden') === 'true') continue;
    const role = roleFor(node);
    if (visibility === 'box' && role && (!roleQuery || role === roleQuery)) {
      const name = nameFor(node, role);
      if (nameMatches(name)) {
        total += 1;
        if (matches.length < QUERY.limit) matches.push(describeMatch(node, role, name));
      }
    }
    const children = renderedChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }

  return JSON.stringify({ marker: MARKER, matches, total });
})()`;
}
