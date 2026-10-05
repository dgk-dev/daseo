import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ARIA_SHARED_SOURCE } from "./aria-snapshot-script.js";

export const READ_SCRIPT_MARKER = "__PASEO_READ__";

/** Below this many characters of article text, `main` falls back to the whole page. */
export const READ_MIN_ARTICLE_CHARS = 500;
/** Characters of the structured-data summary placed before the body. */
export const READ_STRUCTURED_DATA_MAX_CHARS = 2_000;

export interface ReadScriptOptions {
  scope: "main" | "page";
  links: boolean;
  /** Snapshot-engine expression for a ref; the read covers that element only. */
  elementExpression?: string;
}

// Readability (Apache-2.0) and Turndown with its GFM plugin (MIT) run inside the
// page, where the DOM is. Their browser builds are CommonJS files with no
// imports; each is evaluated against a local `module` so nothing lands on the
// page's window.
const LIBRARIES = [
  { name: "TurndownService", packageName: "turndown", file: "turndown.browser.cjs.js" },
  {
    name: "turndownPluginGfm",
    packageName: "turndown-plugin-gfm",
    file: "turndown-plugin-gfm.browser.cjs.js",
  },
  { name: "Readability", packageName: "@mozilla/readability", file: "Readability.js" },
] as const;

let librarySource: string | null = null;

function readLibrarySource(): string {
  if (librarySource !== null) {
    return librarySource;
  }
  const requireFromHere = createRequire(__filename);
  librarySource = LIBRARIES.map(({ name, packageName, file }) => {
    // Resolve the package entry (always exported) and take the browser build beside it.
    const source = readFileSync(join(dirname(requireFromHere.resolve(packageName)), file), "utf8");
    return `const ${name} = (function () {
  const module = { exports: {} };
  const exports = module.exports;
${source}
;
  return module.exports;
})();`;
  }).join("\n");
  return librarySource;
}

export function buildReadScript(options: ReadScriptOptions): string {
  return String.raw`(() => {
  const MARKER = ${JSON.stringify(READ_SCRIPT_MARKER)};
  const OPTIONS = ${JSON.stringify({ scope: options.scope, links: options.links })};
  const MIN_ARTICLE_CHARS = ${READ_MIN_ARTICLE_CHARS};
  const STRUCTURED_MAX_CHARS = ${READ_STRUCTURED_DATA_MAX_CHARS};
${ARIA_SHARED_SOURCE}
${readLibrarySource()}
${READ_PAGE_SOURCE}
  const target = ${options.elementExpression ?? "null"};
  if (${options.elementExpression ? "!target" : "false"}) {
    return JSON.stringify({ marker: MARKER, staleRef: true });
  }
  return JSON.stringify(readPage(target));
})()`;
}

const READ_PAGE_SOURCE = String.raw`
  const SKIPPED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'OBJECT', 'EMBED', 'CANVAS',
    'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'MAP', 'INPUT', 'TEXTAREA', 'DIALOG'
  ]);
  const KEPT_ATTRIBUTES = ['id', 'class', 'role', 'alt', 'colspan', 'rowspan', 'start', 'align'];
  const SECTIONING_TAGS = new Set(['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION']);
  const PAGE_LANDMARK_ROLES = new Set(['banner', 'contentinfo', 'navigation', 'complementary']);
  const inert = document.implementation.createHTMLDocument('');

  function isHidden(element) {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;
    const style = styleOf(element);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  // Page-level landmarks as HTML-AAM maps them: nav is always navigation, header
  // and footer are banner/contentinfo unless inside sectioning content, and aside
  // is complementary unless it sits inside other sectioning content.
  function isPageLandmark(element, insideSectioning) {
    const role = (element.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (PAGE_LANDMARK_ROLES.has(role)) return true;
    const tag = element.tagName;
    if (tag === 'NAV') return true;
    if (tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return !insideSectioning;
    return false;
  }

  function linkHref(element) {
    let href = '';
    try {
      href = typeof element.href === 'string' ? element.href : '';
    } catch {}
    if (!/^(https?:|mailto:|tel:)/i.test(href)) return null;
    // Jumps within the same document say nothing an agent can follow.
    const here = String(element.ownerDocument.location && element.ownerDocument.location.href || '').split('#')[0];
    if (href.includes('#') && href.split('#')[0] === here) return null;
    return href;
  }

  function selectSummary(element) {
    const options = Array.from(element.options || [])
      .map((option) => normalizeText(option.textContent))
      .filter(Boolean);
    if (options.length === 0) return null;
    const shown = options.slice(0, 30).join(' / ');
    const paragraph = inert.createElement('p');
    paragraph.textContent = '[options: ' + shown + (options.length > 30 ? ' / +' + (options.length - 30) + ' more' : '') + ']';
    return paragraph;
  }

  function frameNode(element) {
    const doc = frameDocument(element);
    const body = doc && (doc.body || doc.documentElement);
    if (body) {
      const container = inert.createElement('div');
      appendChildren(container, renderedChildren(body), { stripLandmarks: false, insideSectioning: false });
      return container;
    }
    const src = element.getAttribute('src') || '';
    if (!src) return null;
    const paragraph = inert.createElement('p');
    paragraph.textContent = '[iframe: ' + (element.src || src) + ']';
    return paragraph;
  }

  // A copy of the rendered tree in an inert document: hidden elements, scripts,
  // and media are left out, open shadow roots and same-origin frames are inlined,
  // links carry absolute URLs, and images keep only their alt text.
  function cloneRendered(node, context) {
    if (node.nodeType === 3) return inert.createTextNode(node.textContent || '');
    if (!isElement(node)) return null;
    const tag = node.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag) || node.namespaceURI === 'http://www.w3.org/2000/svg') return null;
    if (isHidden(node)) return null;
    if (context.stripLandmarks && isPageLandmark(node, context.insideSectioning)) return null;
    if (tag === 'IFRAME' || tag === 'FRAME') return frameNode(node);
    if (tag === 'SELECT') return selectSummary(node);
    const copy = inert.createElement(isHtmlElement(node) ? node.tagName.toLowerCase() : 'span');
    for (const name of KEPT_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value !== null) copy.setAttribute(name, value);
    }
    if (tag === 'A') {
      const href = linkHref(node);
      if (href) copy.setAttribute('href', href);
      const label = normalizeText(node.getAttribute('aria-label') || node.getAttribute('title'));
      if (label) copy.setAttribute('data-label', label);
    }
    if (tag === 'IMG') {
      copy.setAttribute('alt', normalizeText(node.getAttribute('alt')));
      return copy;
    }
    appendChildren(copy, renderedChildren(node), {
      stripLandmarks: context.stripLandmarks,
      insideSectioning: context.insideSectioning || SECTIONING_TAGS.has(tag),
    });
    return copy;
  }

  function appendChildren(parent, children, context) {
    for (const child of children) {
      const copy = cloneRendered(child, context);
      if (copy) parent.appendChild(copy);
    }
  }

  // GFM tables need a header row and one line per row. Layout tables (nested
  // tables, role=presentation) become plain blocks; data tables get their first
  // row as the header when they have none.
  function normalizeTables(root) {
    const tables = Array.from(root.querySelectorAll('table')).reverse();
    for (const table of tables) {
      const role = (table.getAttribute('role') || '').toLowerCase();
      if (table.querySelector('table') || role === 'presentation' || role === 'none') {
        unwrapTable(table);
      } else {
        rebuildDataTable(table);
      }
    }
  }

  function unwrapTable(table) {
    const block = inert.createElement('div');
    for (const row of Array.from(table.querySelectorAll(':scope > tr, :scope > * > tr'))) {
      const line = inert.createElement('div');
      for (const cell of Array.from(row.children)) {
        const part = inert.createElement('div');
        while (cell.firstChild) part.appendChild(cell.firstChild);
        line.appendChild(part);
      }
      block.appendChild(line);
    }
    const caption = table.querySelector(':scope > caption');
    if (caption) block.insertBefore(paragraphFrom(caption), block.firstChild);
    table.replaceWith(block);
  }

  function paragraphFrom(element) {
    const paragraph = inert.createElement('p');
    while (element.firstChild) paragraph.appendChild(element.firstChild);
    return paragraph;
  }

  function rebuildDataTable(table) {
    const rows = Array.from(table.querySelectorAll(':scope > tr, :scope > * > tr')).filter(
      (row) => row.children.length > 0,
    );
    if (rows.length === 0) {
      table.remove();
      return;
    }
    const rebuilt = inert.createElement('table');
    const head = inert.createElement('thead');
    const body = inert.createElement('tbody');
    rows.forEach((row, index) => {
      const copy = inert.createElement('tr');
      for (const cell of Array.from(row.children)) {
        const copyCell = inert.createElement(index === 0 ? 'th' : 'td');
        while (cell.firstChild) copyCell.appendChild(cell.firstChild);
        copy.appendChild(copyCell);
      }
      (index === 0 ? head : body).appendChild(copy);
    });
    rebuilt.appendChild(head);
    if (body.childNodes.length > 0) rebuilt.appendChild(body);
    const caption = table.querySelector(':scope > caption');
    if (caption) table.before(paragraphFrom(caption));
    table.replaceWith(rebuilt);
  }

  function cleanCopy(source, stripLandmarks) {
    const container = inert.createElement('div');
    appendChildren(container, source === null ? renderedChildren(document.body || document.documentElement) : [source], {
      stripLandmarks,
      insideSectioning: false,
    });
    normalizeTables(container);
    return container;
  }

  // Readability scores prose density, so on a page whose real content is a short
  // heading and a table it can pick a long sidebar list instead. Its article is
  // kept only when it holds the page's first visible h1. Readability deletes the
  // h1 that repeats the page title, so that heading goes in as a marked paragraph
  // and comes back out as an h1.
  function articleOf(container) {
    const heading = container.querySelector('h1');
    const headingText = heading ? normalizeText(heading.textContent).toLowerCase() : '';
    if (heading) {
      const marker = inert.createElement('p');
      marker.setAttribute('data-paseo-h1', '');
      while (heading.firstChild) marker.appendChild(heading.firstChild);
      heading.replaceWith(marker);
    }
    const doc = document.implementation.createHTMLDocument(document.title || '');
    doc.body.appendChild(doc.importNode(container, true));
    let content;
    try {
      const article = new Readability(doc, { serializer: (element) => element }).parse();
      content = article && article.content;
    } catch {
      return null;
    }
    if (!content) return null;
    const text = normalizeText(content.textContent);
    if (text.length < MIN_ARTICLE_CHARS) return null;
    if (headingText && !text.toLowerCase().includes(headingText)) return null;
    const marker = content.querySelector('[data-paseo-h1]');
    if (marker) {
      const restored = marker.ownerDocument.createElement('h1');
      while (marker.firstChild) restored.appendChild(marker.firstChild);
      marker.replaceWith(restored);
    }
    return content;
  }

  const PRODUCT_TYPES = new Set(['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel']);

  function metaContent(key) {
    const element = document.querySelector('meta[property="' + key + '"], meta[name="' + key + '"]');
    return element ? normalizeText(element.getAttribute('content')) : '';
  }

  function jsonLdItems() {
    const items = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        collectJsonLd(JSON.parse(script.textContent || ''), items);
      } catch {}
    }
    return items;
  }

  // A page that declares itself a product is a heading, a price table, and
  // option lists, not an article; its whole page is the content.
  function isProductPage() {
    if (/^(og:)?product(\.|$)/i.test(metaContent('og:type'))) return true;
    return jsonLdItems().some((item) => typesOf(item).some((type) => PRODUCT_TYPES.has(type)));
  }

  let linkCount = 0;

  function markdownOf(element) {
    const service = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '_',
      hr: '---',
      br: ''
    });
    service.use(turndownPluginGfm.gfm);
    // Escaping Markdown in page text ("1\. Item", "\_id") only costs the reader.
    service.escape = (text) => text;
    service.addRule('paseoImage', {
      filter: 'img',
      replacement: (content, node) => {
        const alt = normalizeText(node.getAttribute('alt'));
        return alt ? '![' + alt + ']' : '';
      }
    });
    service.addRule('paseoLink', {
      filter: 'a',
      replacement: (content, node) => {
        const text = normalizeText(content) || node.getAttribute('data-label') || '';
        const href = node.getAttribute('href');
        if (!text) return '';
        if (!OPTIONS.links || !href) return content;
        linkCount += 1;
        return '[' + text + '](' + href.replace(/[()\s]/g, (character) => encodeURIComponent(character)) + ')';
      }
    });
    service.addRule('paseoTableCell', {
      filter: ['th', 'td'],
      replacement: (content, node) => {
        const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        const text = content.replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
        return (index === 0 ? '| ' : ' ') + text + ' |';
      }
    });
    service.addRule('paseoListItem', {
      filter: 'li',
      replacement: (content, node, options) => {
        const item = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n(?=\S)/g, '\n    ');
        const parent = node.parentNode;
        const separator = node.nextSibling && !/\n$/.test(item) ? '\n' : '';
        if (!parent || parent.nodeName !== 'OL') return options.bulletListMarker + ' ' + item + separator;
        const start = Number(parent.getAttribute('start') || 1);
        const index = Array.prototype.indexOf.call(parent.children, node);
        return (start + index) + '. ' + item + separator;
      }
    });
    return service
      .turndown(element)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function typesOf(item) {
    return asArray(item && item['@type']).map((type) => String(type).replace(/^https?:\/\/schema\.org\//, ''));
  }

  function textOf(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return textOf(value.name !== undefined ? value.name : value['@value']);
    return normalizeText(String(value));
  }

  function availabilityOf(value) {
    return textOf(value).replace(/^https?:\/\/schema\.org\//, '');
  }

  function offerParts(offer) {
    if (!offer || typeof offer !== 'object') return [];
    const currency = textOf(offer.priceCurrency);
    const parts = [];
    if (offer.price !== undefined) {
      parts.push(textOf(offer.price) + (currency ? ' ' + currency : ''));
    } else if (offer.lowPrice !== undefined || offer.highPrice !== undefined) {
      parts.push(textOf(offer.lowPrice) + '–' + textOf(offer.highPrice) + (currency ? ' ' + currency : ''));
    } else if (offer.priceSpecification && offer.priceSpecification.price !== undefined) {
      const specCurrency = textOf(offer.priceSpecification.priceCurrency) || currency;
      parts.push(textOf(offer.priceSpecification.price) + (specCurrency ? ' ' + specCurrency : ''));
    }
    if (offer.availability !== undefined) parts.push(availabilityOf(offer.availability));
    if (offer.offerCount !== undefined) parts.push(textOf(offer.offerCount) + ' offers');
    return parts.filter(Boolean);
  }

  function productParts(item) {
    const parts = [];
    const name = textOf(item.name);
    if (name) parts.push(JSON.stringify(name));
    const offers = asArray(item.offers);
    if (offers.length > 0) parts.push(...offerParts(offers[0]));
    if (offers.length > 1) parts.push(offers.length + ' offers');
    if (item.sku !== undefined) parts.push('sku ' + textOf(item.sku));
    if (item.brand !== undefined && textOf(item.brand)) parts.push('brand ' + textOf(item.brand));
    return parts;
  }

  function collectJsonLd(value, items) {
    if (Array.isArray(value)) {
      for (const entry of value) collectJsonLd(entry, items);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value['@graph']) collectJsonLd(value['@graph'], items);
    if (value['@type']) items.push(value);
  }

  function structuredDataLines() {
    const lines = [];
    for (const item of jsonLdItems()) {
      const types = typesOf(item);
      if (types.includes('ProductGroup')) {
        lines.push('- ProductGroup: ' + productParts(item).join(' · '));
        const variants = asArray(item.hasVariant);
        for (const variant of variants.slice(0, 10)) {
          lines.push('  - variant: ' + productParts(variant).join(' · '));
        }
        if (variants.length > 10) lines.push('  - +' + (variants.length - 10) + ' more variants');
      } else if (types.some((type) => type === 'Product' || type === 'IndividualProduct' || type === 'ProductModel')) {
        lines.push('- Product: ' + productParts(item).join(' · '));
        for (const offer of asArray(item.offers).slice(1, 5)) {
          const parts = offerParts(offer);
          const name = textOf(offer && offer.name);
          if (parts.length > 0) lines.push('  - offer: ' + (name ? JSON.stringify(name) + ' · ' : '') + parts.join(' · '));
        }
      } else if (types.some((type) => type === 'Offer' || type === 'AggregateOffer')) {
        const parts = offerParts(item);
        if (parts.length > 0) lines.push('- Offer: ' + parts.join(' · '));
      } else if (types.some((type) => /Article$/.test(type) || type === 'BlogPosting' || type === 'Report')) {
        const parts = [];
        const headline = textOf(item.headline || item.name);
        if (headline) parts.push(JSON.stringify(headline));
        if (item.datePublished) parts.push('published ' + textOf(item.datePublished));
        const author = asArray(item.author).map(textOf).filter(Boolean).join(', ');
        if (author) parts.push('by ' + author);
        if (parts.length > 0) lines.push('- ' + types[0] + ': ' + parts.join(' · '));
      } else if (types.includes('Organization') && textOf(item.name)) {
        lines.push('- Organization: ' + JSON.stringify(textOf(item.name)));
      }
    }
    const meta = metaContent;
    const og = [];
    for (const key of ['title', 'type', 'description', 'image']) {
      const value = meta('og:' + key);
      if (value) og.push(key + ' ' + (key === 'image' || key === 'type' ? value : JSON.stringify(value)));
    }
    if (og.length > 0) lines.push('- og: ' + og.join(' · '));
    const price = meta('product:price:amount');
    const currency = meta('product:price:currency');
    const availability = meta('product:availability');
    const product = [];
    if (price) product.push('price ' + price + (currency ? ' ' + currency : ''));
    if (availability) product.push('availability ' + availability);
    if (product.length > 0) lines.push('- product meta: ' + product.join(' · '));
    return lines;
  }

  function structuredDataBlock() {
    const lines = structuredDataLines();
    if (lines.length === 0) return '';
    let block = 'Structured data:';
    for (const line of lines) {
      if (block.length + 1 + line.length > STRUCTURED_MAX_CHARS) {
        block += '\n- …';
        break;
      }
      block += '\n' + line;
    }
    return block;
  }

  function readPage(element) {
    let scope;
    let body;
    // Why main became page: a product page, or no article holding the h1.
    let mainFallback = null;
    if (element) {
      scope = 'ref';
      body = markdownOf(cleanCopy(element, false));
    } else {
      let article = null;
      if (OPTIONS.scope === 'main') {
        if (isProductPage()) {
          mainFallback = 'product_page';
        } else {
          article = articleOf(cleanCopy(null, false));
          if (!article) mainFallback = 'no_article';
        }
      }
      scope = article ? 'main' : 'page';
      body = markdownOf(article || cleanCopy(null, true));
    }
    const structured = element ? '' : structuredDataBlock();
    return {
      marker: MARKER,
      scope,
      ...(mainFallback ? { mainFallback } : {}),
      content: structured ? structured + '\n\n' + body : body,
      links: linkCount,
      structuredDataFound: structured.length > 0
    };
  }
`;
