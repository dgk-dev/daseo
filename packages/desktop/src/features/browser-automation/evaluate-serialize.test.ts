import { describe, expect, test } from "vitest";
import { serializeEvaluateValue } from "./evaluate-serialize.js";

const MAX = 100_000;

function inPage(value: unknown, maxLength = MAX): string {
  // The service injects the function as source text; run it the same way.
  const fn = new Function(`return (${serializeEvaluateValue.toString()});`)() as (
    value: unknown,
    maxLength: number,
  ) => string;
  return fn(value, maxLength);
}

describe("serializeEvaluateValue", () => {
  test("values JSON can hold come back exactly as JSON.stringify writes them", () => {
    const samples: unknown[] = [
      null,
      0,
      -1.5,
      "text",
      true,
      [1, "a", null, { b: [2, 3] }],
      { a: 1, nested: { list: ["x"], flag: false } },
      { when: new Date("2026-11-11T00:00:00.000Z") },
      { shared: [1], again: null },
    ];
    for (const sample of samples) {
      expect(inPage(sample)).toBe(JSON.stringify(sample));
    }
    const shared = { x: 1 };
    expect(inPage({ a: shared, b: shared })).toBe(JSON.stringify({ a: shared, b: shared }));
  });

  test("undefined, NaN, Infinity, and BigInt are written instead of lost or failing", () => {
    expect(inPage(undefined)).toBe("undefined");
    expect(inPage(Number.NaN)).toBe("NaN");
    expect(inPage([Infinity, -Infinity, 1])).toBe("[Infinity,-Infinity,1]");
    expect(inPage({ big: 12345678901234567890n })).toBe('{"big":12345678901234567890n}');
    expect(inPage({ kept: undefined, n: 1 })).toBe('{"kept":undefined,"n":1}');
  });

  test("circular objects, Maps, Sets, errors, regexes, and functions are readable", () => {
    const loop: Record<string, unknown> = { name: "root" };
    loop.self = loop;
    expect(inPage(loop)).toBe('{"name":"root","self":[Circular]}');
    expect(
      inPage(
        new Map<unknown, unknown>([
          ["a", 1],
          [2, new Set(["x"])],
        ]),
      ),
    ).toBe('Map(2){"a"=>1,2=>Set(1)["x"]}');
    expect(inPage({ error: new TypeError("bad input") })).toBe('{"error":"TypeError: bad input"}');
    expect(inPage([/a+b/gi, function named() {}])).toBe("[/a+b/gi,[Function named]]");
  });

  test("DOM nodes are described by tag, id, and class", () => {
    class FakeNode {
      public readonly fake = true;
    }
    class FakeElement extends FakeNode {
      public readonly nodeType = 1;
      public readonly tagName = "BUTTON";
      public readonly id = "go";
      public getAttribute(name: string) {
        return name === "class" ? "btn primary" : null;
      }
    }
    const g = globalThis as Record<string, unknown>;
    const previous = g.Node;
    g.Node = FakeNode;
    try {
      expect(inPage({ button: new FakeElement() })).toBe(
        '{"button":<button id="go" class="btn primary">}',
      );
    } finally {
      g.Node = previous;
    }
  });

  test("a huge readable value stops growing past the cap", () => {
    const big = Array.from({ length: 10_000 }, (_, index) => ({ index, missing: undefined }));
    const text = inPage(big, 1_000);
    expect(text.length).toBeLessThan(1_100);
    expect(text.startsWith('[{"index":0,"missing":undefined}')).toBe(true);
  });
});
