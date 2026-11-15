/**
 * Finds `![alt](source)` images in streamed assistant Markdown and lets a caller replace the
 * source. Fenced and inline code stay untouched because the app renders them as text, not as
 * images. The scanner state crosses item boundaries: an assistant reply arrives as several
 * timeline items, and a fence opened in one item still covers the next.
 */
export interface MarkdownImageScanState {
  fence: { char: "`" | "~"; length: number } | null;
  /** Length of a backtick run that opened an inline code span on the current, unfinished line. */
  inlineCodeRun: number;
}

export function createMarkdownImageScanState(): MarkdownImageScanState {
  return { fence: null, inlineCodeRun: 0 };
}

export type MarkdownImageSourceRewrite = (source: string) => string | null;

type ImageParse =
  | { status: "complete"; end: number; destinationStart: number; destinationEnd: number }
  | { status: "incomplete" }
  | { status: "invalid" };

function findLabelEnd(text: string, start: number): number | "incomplete" | "invalid" {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n" && text[index + 1] === "\n") {
      return "invalid";
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return "incomplete";
}

function parseDestination(
  text: string,
  start: number,
): { start: number; end: number; next: number } | "incomplete" | "invalid" {
  let index = start;
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  if (index >= text.length) {
    return "incomplete";
  }
  if (text[index] === "<") {
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === "\\") {
        cursor += 1;
        continue;
      }
      if (char === "\n" || char === "<") {
        return "invalid";
      }
      if (char === ">") {
        return { start: index, end: cursor + 1, next: cursor + 1 };
      }
    }
    return "incomplete";
  }
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      return cursor === index ? "invalid" : { start: index, end: cursor, next: cursor };
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) {
        return cursor === index ? "invalid" : { start: index, end: cursor, next: cursor };
      }
      depth -= 1;
    }
  }
  return "incomplete";
}

function parseTitleAndClose(text: string, start: number): number | "incomplete" | "invalid" {
  let index = start;
  while (index < text.length && /[ \t\n]/.test(text[index] ?? "")) {
    index += 1;
  }
  if (index >= text.length) {
    return "incomplete";
  }
  if (text[index] === ")") {
    return index + 1;
  }
  const opener = text[index];
  const closer = opener === "(" ? ")" : opener;
  if (opener !== '"' && opener !== "'" && opener !== "(") {
    return "invalid";
  }
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === closer) {
      let after = cursor + 1;
      while (after < text.length && (text[after] === " " || text[after] === "\t")) {
        after += 1;
      }
      if (after >= text.length) {
        return "incomplete";
      }
      return text[after] === ")" ? after + 1 : "invalid";
    }
  }
  return "incomplete";
}

/** Parses an image that starts with `![` at `start`. */
function parseImage(text: string, start: number): ImageParse {
  const labelEnd = findLabelEnd(text, start + 2);
  if (labelEnd === "incomplete" || labelEnd === "invalid") {
    return { status: labelEnd };
  }
  const openParen = labelEnd + 1;
  if (openParen >= text.length) {
    return { status: "incomplete" };
  }
  if (text[openParen] !== "(") {
    return { status: "invalid" };
  }
  const destination = parseDestination(text, openParen + 1);
  if (destination === "incomplete" || destination === "invalid") {
    return { status: destination };
  }
  const end = parseTitleAndClose(text, destination.next);
  if (end === "incomplete" || end === "invalid") {
    return { status: end };
  }
  return {
    status: "complete",
    end,
    destinationStart: destination.start,
    destinationEnd: destination.end,
  };
}

function unescapeDestination(raw: string): string {
  const inner = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  return inner.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function backtickRunLength(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") {
    end += 1;
  }
  return end - start;
}

function findClosingBacktickRun(text: string, from: number, length: number): number | null {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      return null;
    }
    if (char !== "`") {
      continue;
    }
    const run = backtickRunLength(text, index);
    if (run === length) {
      return index + run;
    }
    index += run - 1;
  }
  return null;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

function closesFence(line: string, fence: NonNullable<MarkdownImageScanState["fence"]>): boolean {
  const match = line.replace(/\r?\n$/, "").match(/^ {0,3}(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length);
}

function rewriteInlineSegment(input: {
  text: string;
  state: MarkdownImageScanState;
  rewrite: MarkdownImageSourceRewrite;
}): string {
  const { text, state, rewrite } = input;
  let output = "";
  let index = 0;
  if (state.inlineCodeRun > 0) {
    const close = findClosingBacktickRun(text, 0, state.inlineCodeRun);
    if (close === null) {
      return text;
    }
    state.inlineCodeRun = 0;
    output += text.slice(0, close);
    index = close;
  }
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = backtickRunLength(text, index);
      const close = findClosingBacktickRun(text, index + run, run);
      if (close === null) {
        // An unclosed run at the end of an unfinished line may close in the next item.
        state.inlineCodeRun = run;
        return output + text.slice(index);
      }
      output += text.slice(index, close);
      index = close;
      continue;
    }
    if (char === "!" && text[index + 1] === "[") {
      const image = parseImage(text, index);
      if (image.status === "complete") {
        const raw = text.slice(image.destinationStart, image.destinationEnd);
        const replacement = rewrite(unescapeDestination(raw));
        output += text.slice(index, image.destinationStart);
        output += replacement ?? raw;
        output += text.slice(image.destinationEnd, image.end);
        index = image.end;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

/**
 * Rewrites every image source in `text` with `rewrite` (a `null` result keeps the source) and
 * advances `state` past the text. `rewrite` receives the destination with Markdown escapes and
 * angle brackets removed and must return a ready-to-insert Markdown destination.
 */
export function rewriteMarkdownImageSources(input: {
  text: string;
  state: MarkdownImageScanState;
  rewrite: MarkdownImageSourceRewrite;
}): string {
  const { state, rewrite } = input;
  const lines = input.text.split(/(?<=\n)/);
  let output = "";
  for (const line of lines) {
    const ended = line.endsWith("\n");
    if (state.fence) {
      if (closesFence(line, state.fence)) {
        state.fence = null;
      }
      output += line;
      continue;
    }
    const fence = state.inlineCodeRun === 0 ? line.match(FENCE_PATTERN) : null;
    if (fence) {
      const marker = fence[1];
      state.fence = { char: marker[0] as "`" | "~", length: marker.length };
      output += line;
      continue;
    }
    output += rewriteInlineSegment({ text: line, state, rewrite });
    if (ended) {
      state.inlineCodeRun = 0;
    }
  }
  return output;
}

/**
 * Splits `text` before a trailing image whose Markdown has started but not finished, so a
 * streaming flush can hold that tail back until the rest of the image arrives.
 */
export function splitTrailingIncompleteMarkdownImage(text: string): {
  complete: string;
  pending: string;
} {
  const lineStart = text.lastIndexOf("\n") + 1;
  let candidate = text.lastIndexOf("![", text.length);
  while (candidate >= lineStart) {
    if (parseImage(text, candidate).status === "incomplete") {
      return { complete: text.slice(0, candidate), pending: text.slice(candidate) };
    }
    candidate = candidate === 0 ? -1 : text.lastIndexOf("![", candidate - 1);
  }
  if (text.endsWith("!")) {
    return { complete: text.slice(0, -1), pending: "!" };
  }
  return { complete: text, pending: "" };
}
