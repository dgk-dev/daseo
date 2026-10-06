import type {
  BrowserAutomationStyleRule,
  BrowserAutomationStylesResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { CdpCommandSender } from "./cdp-session-queue.js";

// What DevTools' Styles pane shows, from the same CDP calls: CSS.getMatchedStylesForNode
// for the cascade and CSS.getComputedStyleForNode for the result. Agents scanned
// document.styleSheets by hand before (45 times in 30 days), which skips
// cross-origin sheets and cannot tell which rule wins.

interface CdpCssProperty {
  name: string;
  value: string;
  important?: boolean;
  implicit?: boolean;
  parsedOk?: boolean;
  disabled?: boolean;
  /** Present on declarations written in the source; absent on Chromium's parsed copies. */
  range?: { startLine: number };
}

interface CdpCssStyle {
  styleSheetId?: string;
  cssProperties: CdpCssProperty[];
  range?: { startLine: number };
}

interface CdpCssRule {
  styleSheetId?: string;
  selectorList: { selectors: Array<{ text: string }>; text: string };
  origin: string;
  style: CdpCssStyle;
  media?: Array<{ text: string }>;
  containerQueries?: Array<{ text: string; name?: string }>;
  supports?: Array<{ text: string }>;
  layers?: Array<{ text: string }>;
  scopes?: Array<{ text: string }>;
}

interface CdpRuleMatch {
  rule: CdpCssRule;
  matchingSelectors?: number[];
}

export interface CdpMatchedStyles {
  inlineStyle?: CdpCssStyle;
  attributesStyle?: CdpCssStyle;
  matchedCSSRules?: CdpRuleMatch[];
  inherited?: Array<{ inlineStyle?: CdpCssStyle; matchedCSSRules?: CdpRuleMatch[] }>;
}

export interface StyleSheetHeader {
  sourceURL: string;
  startLine: number;
  isInline: boolean;
}

export interface RawElementStyles {
  /** tag#id.class of the element, then of each ancestor from the parent up. */
  element: string;
  ancestors: string[];
  pageUrl: string;
  matched: CdpMatchedStyles;
  computed: Array<{ name: string; value: string }>;
  sheets: Record<string, StyleSheetHeader>;
}

export type CdpEventSubscriber = (
  listener: (method: string, params: Record<string, unknown> | undefined) => void,
) => () => void;

const LABEL_SNIPPET = String.raw`const label = (node) => {
      const id = node.id ? '#' + node.id : '';
      const classes = typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      return node.localName + id + classes;
    };`;

/**
 * Runs the CDP calls for one element. `elementExpression` evaluates to the
 * element or null; null comes back as "stale_ref".
 */
export async function collectElementStyles(input: {
  send: CdpCommandSender;
  subscribe: CdpEventSubscriber;
  elementExpression: string;
}): Promise<RawElementStyles | "stale_ref"> {
  const { send } = input;
  const sheets: Record<string, StyleSheetHeader> = {};
  const unsubscribe = input.subscribe((method, params) => {
    if (method !== "CSS.styleSheetAdded") {
      return;
    }
    const header = params?.header as Record<string, unknown> | undefined;
    if (header && typeof header.styleSheetId === "string") {
      sheets[header.styleSheetId] = {
        sourceURL: typeof header.sourceURL === "string" ? header.sourceURL : "",
        startLine: typeof header.startLine === "number" ? header.startLine : 0,
        isInline: header.isInline === true,
      };
    }
  });
  const objectGroup = "paseo-browser-styles";
  try {
    const evaluated = (await send("Runtime.evaluate", {
      expression: input.elementExpression,
      objectGroup,
      returnByValue: false,
    })) as { result?: { objectId?: string; subtype?: string } };
    const objectId = evaluated.result?.objectId;
    if (!objectId || evaluated.result?.subtype === "null") {
      return "stale_ref";
    }
    const labels = (await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
    ${LABEL_SNIPPET}
    const ancestors = [];
    for (let node = this.parentElement; node; node = node.parentElement) ancestors.push(label(node));
    return { element: label(this), ancestors, pageUrl: location.href };
  }`,
      returnByValue: true,
    })) as { result?: { value?: { element: string; ancestors: string[]; pageUrl: string } } };
    // CSS.enable reports every existing stylesheet through styleSheetAdded before it returns.
    await send("DOM.enable");
    await send("CSS.enable");
    await send("DOM.getDocument", { depth: 0 });
    const requested = (await send("DOM.requestNode", { objectId })) as { nodeId?: number };
    if (!requested.nodeId) {
      return "stale_ref";
    }
    const matched = (await send("CSS.getMatchedStylesForNode", {
      nodeId: requested.nodeId,
    })) as CdpMatchedStyles;
    const computed = (await send("CSS.getComputedStyleForNode", {
      nodeId: requested.nodeId,
    })) as { computedStyle?: Array<{ name: string; value: string }> };
    const label = labels.result?.value;
    return {
      element: label?.element ?? "element",
      ancestors: label?.ancestors ?? [],
      pageUrl: label?.pageUrl ?? "",
      matched,
      computed: computed.computedStyle ?? [],
      sheets,
    };
  } finally {
    unsubscribe();
    // Leaving CSS and DOM enabled makes Chromium track every style change in the tab.
    await send("CSS.disable").catch(() => undefined);
    await send("DOM.disable").catch(() => undefined);
    await send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
  }
}

// Properties a child takes from its parent when nothing sets them on the child.
const INHERITED_PROPERTY_PATTERN =
  /^(?:--.*|color|cursor|direction|visibility|quotes|caret-color|accent-color|color-scheme|font(?:-.*)?|letter-spacing|line-height|list-style(?:-.*)?|tab-size|text-(?:align(?:-last)?|indent|justify|shadow|transform|rendering|underline-position|wrap|size-adjust)|white-space(?:-collapse)?|word-(?:break|spacing)|overflow-wrap|hyphens|writing-mode|orphans|widows|-webkit-text-.*)$/;

interface RuleEntry {
  rule: BrowserAutomationStyleRule;
  /** Index of the element the rule matched: 0 for the element, n for its n-th ancestor. */
  elementIndex: number;
}

export function summarizeElementStyles(
  raw: RawElementStyles,
  options: { browserId: string; ref: string; properties?: string[]; maxRules: number },
): BrowserAutomationStylesResult {
  const wanted = (name: string) =>
    !options.properties ||
    options.properties.some((property) => propertyMatches(name, property.trim().toLowerCase()));
  let userAgentRules = 0;
  const entries: RuleEntry[] = [];

  const addStyle = (
    style: CdpCssStyle | undefined,
    selector: string,
    elementIndex: number,
    extra: Partial<BrowserAutomationStyleRule> = {},
  ) => {
    if (!style) {
      return;
    }
    // A style with source text lists each declaration twice: as written (with a
    // range) and as parsed (without). DevTools shows the written ones.
    const written = style.cssProperties.some((property) => property.range);
    const declarations = style.cssProperties
      .filter((property) => !written || property.range)
      .filter((property) => !property.implicit && !property.disabled)
      .filter((property) => elementIndex === 0 || INHERITED_PROPERTY_PATTERN.test(property.name))
      .filter((property) => wanted(property.name))
      .map((property) => {
        const declaration: BrowserAutomationStyleRule["declarations"][number] = {
          name: property.name,
          value: property.value,
        };
        if (property.important) declaration.important = true;
        if (property.parsedOk === false) declaration.invalid = true;
        return declaration;
      });
    if (declarations.length === 0) {
      return;
    }
    entries.push({
      elementIndex,
      rule: {
        selector,
        ...extra,
        ...(elementIndex > 0
          ? { inheritedFrom: raw.ancestors[elementIndex - 1] ?? `ancestor ${elementIndex}` }
          : {}),
        declarations,
      },
    });
  };

  const addRules = (matches: CdpRuleMatch[] | undefined, elementIndex: number) => {
    // CDP lists matched rules from lowest to highest precedence.
    const list = matches ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const match = list[index];
      if (!match) continue;
      if (match.rule.origin === "user-agent") {
        userAgentRules += 1;
        continue;
      }
      addStyle(match.rule.style, matchingSelectorText(match), elementIndex, {
        ...ruleSource(match.rule, raw),
        ...ruleConditions(match.rule),
      });
    }
  };

  addStyle(raw.matched.inlineStyle, "element.style", 0);
  addRules(raw.matched.matchedCSSRules, 0);
  addStyle(raw.matched.attributesStyle, "attributes", 0);
  (raw.matched.inherited ?? []).forEach((ancestor, index) => {
    addStyle(ancestor.inlineStyle, "element.style", index + 1);
    addRules(ancestor.matchedCSSRules, index + 1);
  });

  markOverridden(entries);
  const rules = entries.map((entry) => entry.rule);
  const shown = rules.slice(0, options.maxRules);
  const setNames = new Set(shown.flatMap((rule) => rule.declarations.map((d) => d.name)));
  const computed: Record<string, string> = {};
  for (const { name, value } of raw.computed) {
    const relevant = options.properties
      ? wanted(name)
      : [...setNames].some((declared) => propertyMatches(name, declared));
    if (relevant && Object.keys(computed).length < 80) {
      computed[name] = value;
    }
  }
  return {
    command: "styles",
    browserId: options.browserId,
    ref: options.ref,
    element: raw.element,
    rules: shown,
    computed,
    userAgentRules,
    truncated: rules.length > shown.length,
  };
}

/** `margin` matches `margin-top` and the other way round; custom properties match exactly. */
function propertyMatches(name: string, property: string): boolean {
  if (name === property) {
    return true;
  }
  if (name.startsWith("--") || property.startsWith("--")) {
    return false;
  }
  return name.startsWith(`${property}-`) || property.startsWith(`${name}-`);
}

// Within one element an !important declaration beats a normal one and, among
// equals, the higher-precedence rule wins, and inside one rule the later
// declaration. Across elements the nearest element that sets an inherited
// property decides it.
function markOverridden(entries: RuleEntry[]): void {
  type Declaration = BrowserAutomationStyleRule["declarations"][number];
  const winners = new Map<string, { elementIndex: number; declaration: Declaration }>();
  for (const entry of entries) {
    const declarations = entry.rule.declarations;
    for (let index = declarations.length - 1; index >= 0; index -= 1) {
      const declaration = declarations[index];
      if (!declaration) continue;
      if (declaration.invalid) {
        continue;
      }
      const current = winners.get(declaration.name);
      if (
        !current ||
        (current.elementIndex === entry.elementIndex &&
          declaration.important === true &&
          current.declaration.important !== true)
      ) {
        winners.set(declaration.name, { elementIndex: entry.elementIndex, declaration });
      }
    }
  }
  for (const entry of entries) {
    for (const declaration of entry.rule.declarations) {
      const winner = winners.get(declaration.name);
      if (!declaration.invalid && winner && winner.declaration !== declaration) {
        declaration.overridden = true;
      }
    }
  }
}

function matchingSelectorText(match: CdpRuleMatch): string {
  const selectors = match.rule.selectorList.selectors;
  const matching = (match.matchingSelectors ?? [])
    .map((index) => selectors[index]?.text)
    .filter((text): text is string => Boolean(text));
  return matching.length > 0 ? matching.join(", ") : match.rule.selectorList.text;
}

function ruleSource(
  rule: CdpCssRule,
  raw: RawElementStyles,
): Pick<BrowserAutomationStyleRule, "source" | "line"> {
  const header = rule.styleSheetId ? raw.sheets[rule.styleSheetId] : undefined;
  if (!header) {
    return {};
  }
  let source = "constructed stylesheet";
  if (header.sourceURL && !(header.isInline && header.sourceURL === raw.pageUrl)) {
    source = header.sourceURL;
  } else if (header.isInline) {
    source = `${raw.pageUrl} (inline <style>)`;
  }
  const line =
    typeof rule.style.range?.startLine === "number"
      ? header.startLine + rule.style.range.startLine + 1
      : undefined;
  return { source, ...(line ? { line } : {}) };
}

function ruleConditions(rule: CdpCssRule): Pick<BrowserAutomationStyleRule, "conditions"> {
  const conditions = [
    ...(rule.layers ?? []).map((layer) => `@layer ${layer.text}`),
    ...(rule.supports ?? []).map((supports) => `@supports ${supports.text}`),
    ...(rule.media ?? []).map((media) => `@media ${media.text}`),
    ...(rule.containerQueries ?? []).map(
      (query) => `@container ${query.name ? `${query.name} ` : ""}${query.text}`,
    ),
    ...(rule.scopes ?? []).map((scope) => `@scope ${scope.text}`),
  ];
  return conditions.length > 0 ? { conditions } : {};
}
