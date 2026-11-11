// Daseo delta 92. browser_evaluate used to return JSON.stringify(value): undefined became null, NaN
// and Infinity became null, a BigInt or a circular object failed the call, and a DOM node, Map, or
// Set came back as {}. Values JSON can hold still serialize exactly as JSON.stringify writes them;
// a value holding anything else is written in the same compact shape with readable tokens in place
// of what JSON would lose (as Playwright MCP 0.0.85 does).
//
// The function runs inside the page: it is injected with Function.prototype.toString, so every
// helper lives inside it and nothing from this module's scope is used.

/** Serializes an evaluate result for the agent. Output may exceed maxLength by one token. */
export function serializeEvaluateValue(value: unknown, maxLength: number): string {
  const MAX_DEPTH = 20;
  const MAX_WALK = 20000;
  const g = globalThis as unknown as Record<string, unknown>;
  const NodeCtor = typeof g.Node === "function" ? (g.Node as new () => object) : null;
  const WindowCtor = typeof g.Window === "function" ? (g.Window as new () => object) : null;

  /** Objects JSON.stringify turns into {} or a string that loses what they are. */
  const isOpaqueObject = (object: object): boolean =>
    (NodeCtor !== null && object instanceof NodeCtor) ||
    (WindowCtor !== null && object instanceof WindowCtor) ||
    object instanceof Map ||
    object instanceof Set ||
    object instanceof Error ||
    object instanceof RegExp ||
    object instanceof WeakMap ||
    object instanceof WeakSet ||
    object instanceof Promise;

  const isLossyLeaf = (leaf: unknown): boolean => {
    const type = typeof leaf;
    if (type === "number") return !Number.isFinite(leaf as number);
    return type === "undefined" || type === "bigint" || type === "symbol" || type === "function";
  };

  const pushChildren = (object: Record<string, unknown>, stack: unknown[]): boolean => {
    if (Array.isArray(object)) {
      for (const item of object) stack.push(item);
      return true;
    }
    for (const key of Object.keys(object)) {
      try {
        stack.push(object[key]);
      } catch {
        return false;
      }
    }
    return true;
  };

  const isPlainJsonSafe = (root: unknown): boolean => {
    const seen = new Set<object>();
    const stack: unknown[] = [root];
    for (let visited = 0; stack.length > 0; visited += 1) {
      if (visited > MAX_WALK) return true;
      const current = stack.pop();
      if (isLossyLeaf(current)) return false;
      if (current === null || typeof current !== "object") continue;
      const object = current as Record<string, unknown>;
      if (typeof object.toJSON === "function") continue;
      if (seen.has(object) || isOpaqueObject(object)) return false;
      seen.add(object);
      if (!pushChildren(object, stack)) return false;
    }
    return true;
  };

  if (isPlainJsonSafe(value)) {
    return JSON.stringify(value) ?? "null";
  }

  let out = "";
  const ancestors: object[] = [];
  const write = (text: string) => {
    out += text;
  };
  const full = () => out.length > maxLength;

  const describeElement = (node: Record<string, unknown>): string => {
    const tag = String(node.tagName ?? "element").toLowerCase();
    const id = typeof node.id === "string" && node.id ? ` id=${JSON.stringify(node.id)}` : "";
    const className =
      typeof node.getAttribute === "function"
        ? (node.getAttribute as (name: string) => string | null).call(node, "class")
        : null;
    const classes = className ? ` class=${JSON.stringify(className)}` : "";
    return `<${tag}${id}${classes}>`;
  };

  const describeNode = (node: Record<string, unknown>): string => {
    if (node.nodeType === 1) return describeElement(node);
    if (node.nodeType === 3) {
      return `#text ${JSON.stringify(String(node.textContent ?? "").slice(0, 80))}`;
    }
    if (node.nodeType === 9) return `#document ${JSON.stringify(String(node.URL ?? ""))}`;
    return `#${String(node.nodeName ?? "node").toLowerCase()}`;
  };

  const describeNumber = (number: number): string => {
    if (Number.isFinite(number)) return Object.is(number, -0) ? "-0" : String(number);
    if (Number.isNaN(number)) return "NaN";
    return number > 0 ? "Infinity" : "-Infinity";
  };

  /** The text for a value that is not a container, or null for one that is. */
  const describeLeaf = (current: unknown): string | null => {
    if (current === undefined) return "undefined";
    if (current === null) return "null";
    const type = typeof current;
    if (type === "number") return describeNumber(current as number);
    if (type === "bigint") return `${String(current)}n`;
    if (type === "string" || type === "boolean") return JSON.stringify(current);
    if (type === "symbol") return String(current);
    if (type === "function") {
      const name = (current as { name?: string }).name;
      return `[Function${name ? ` ${name}` : ""}]`;
    }
    return null;
  };

  /** The text for an object JSON cannot show, or null for a plain object or array. */
  const describeOpaque = (object: object): string | null => {
    if (ancestors.includes(object)) return "[Circular]";
    if (NodeCtor !== null && object instanceof NodeCtor) {
      return describeNode(object as Record<string, unknown>);
    }
    if (WindowCtor !== null && object instanceof WindowCtor) return "[Window]";
    if (object instanceof Error) return JSON.stringify(`${object.name}: ${object.message}`);
    if (object instanceof RegExp) return String(object);
    if (object instanceof Promise) return "[Promise]";
    if (object instanceof WeakMap) return "[WeakMap]";
    if (object instanceof WeakSet) return "[WeakSet]";
    return null;
  };

  const writeEntries = (
    open: string,
    close: string,
    entries: Iterable<unknown>,
    writeEntry: (entry: unknown) => void,
  ) => {
    write(open);
    let first = true;
    for (const entry of entries) {
      if (full()) break;
      if (!first) write(",");
      first = false;
      writeEntry(entry);
    }
    write(close);
  };

  const writeContainer = (object: Record<string, unknown>, depth: number) => {
    if (object instanceof Map) {
      writeEntries(`Map(${object.size}){`, "}", object, (entry) => {
        const [key, item] = entry as [unknown, unknown];
        visit(key, depth + 1);
        write("=>");
        visit(item, depth + 1);
      });
      return;
    }
    if (object instanceof Set) {
      writeEntries(`Set(${object.size})[`, "]", object, (item) => visit(item, depth + 1));
      return;
    }
    if (Array.isArray(object)) {
      writeEntries("[", "]", object, (item) => visit(item, depth + 1));
      return;
    }
    writeEntries("{", "}", Object.keys(object), (key) => {
      write(`${JSON.stringify(key)}:`);
      let child: unknown;
      try {
        child = object[key as string];
      } catch (error) {
        write(`[Thrown: ${JSON.stringify(String(error))}]`);
        return;
      }
      visit(child, depth + 1);
    });
  };

  const visit = (current: unknown, depth: number): void => {
    if (full()) return;
    const leaf = describeLeaf(current);
    if (leaf !== null) return write(leaf);
    const object = current as Record<string, unknown>;
    const opaque = describeOpaque(object);
    if (opaque !== null) return write(opaque);
    if (depth >= MAX_DEPTH) return write(Array.isArray(object) ? "[Array]" : "[Object]");
    if (typeof object.toJSON === "function") {
      let json: unknown;
      try {
        json = (object.toJSON as () => unknown).call(object);
      } catch (error) {
        return write(`[Thrown: ${JSON.stringify(String(error))}]`);
      }
      if (json !== object) return visit(json, depth + 1);
    }
    ancestors.push(object);
    try {
      writeContainer(object, depth);
    } finally {
      ancestors.pop();
    }
  };

  visit(value, 0);
  return out;
}
