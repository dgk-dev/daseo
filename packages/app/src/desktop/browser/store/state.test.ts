import { describe, expect, it } from "vitest";
import {
  applyBrowserPatch,
  type BrowserIndexState,
  createFixedBrowserViewport,
  createBrowserRecord,
  normalizeBrowserIndexState,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  resolveBrowserAddressInput,
  sanitizeBrowsersForPersist,
} from "./state";

function withRecords(records: ReturnType<typeof createBrowserRecord>[]): BrowserIndexState {
  return {
    browsersById: Object.fromEntries(records.map((record) => [record.browserId, record])),
  };
}

describe("normalizeBrowserUrl", () => {
  it("normalizes local development hosts to http by default", () => {
    expect(normalizeBrowserUrl("localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeBrowserUrl("localhost/path")).toBe("http://localhost/path");
    expect(normalizeBrowserUrl("127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000/path");
    expect(normalizeBrowserUrl("192.168.0.8")).toBe("http://192.168.0.8");
    expect(normalizeBrowserUrl("[::1]:5173")).toBe("http://[::1]:5173");
  });

  it("normalizes public hosts to https by default", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("//example.com/path")).toBe("https://example.com/path");
  });

  it("keeps explicit protocols unchanged", () => {
    expect(normalizeBrowserUrl("http://localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeBrowserUrl("https://localhost:8081")).toBe("https://localhost:8081");
    expect(normalizeBrowserUrl("file:///tmp/example.html")).toBe("file:///tmp/example.html");
  });

  it("falls back to a default URL when input is blank", () => {
    expect(normalizeBrowserUrl(null)).toBe("https://www.google.com");
    expect(normalizeBrowserUrl("   ")).toBe("https://www.google.com");
  });

  it("treats a public host with a port as a host, not a scheme", () => {
    expect(normalizeBrowserUrl("example.com:8080/path")).toBe("https://example.com:8080/path");
  });
});

describe("resolveBrowserAddressInput", () => {
  it("navigates URL-shaped input", () => {
    expect(resolveBrowserAddressInput("google.com")).toBe("https://google.com");
    expect(resolveBrowserAddressInput("docs.example.co.kr/a?b=1")).toBe(
      "https://docs.example.co.kr/a?b=1",
    );
    expect(resolveBrowserAddressInput("localhost:8081")).toBe("http://localhost:8081");
    expect(resolveBrowserAddressInput("192.168.0.8")).toBe("http://192.168.0.8");
    expect(resolveBrowserAddressInput("https://example.com")).toBe("https://example.com");
    expect(resolveBrowserAddressInput("about:blank")).toBe("about:blank");
    expect(resolveBrowserAddressInput("example.com:8080")).toBe("https://example.com:8080");
  });

  it("searches Google for everything else", () => {
    expect(resolveBrowserAddressInput("날씨")).toBe(
      `https://www.google.com/search?q=${encodeURIComponent("날씨")}`,
    );
    expect(resolveBrowserAddressInput("react useEffect cleanup")).toBe(
      "https://www.google.com/search?q=react%20useEffect%20cleanup",
    );
    expect(resolveBrowserAddressInput("naver")).toBe("https://www.google.com/search?q=naver");
    expect(resolveBrowserAddressInput("3.14")).toBe("https://www.google.com/search?q=3.14");
    expect(resolveBrowserAddressInput("what is example.com")).toBe(
      "https://www.google.com/search?q=what%20is%20example.com",
    );
  });

  it("opens Google when input is blank", () => {
    expect(resolveBrowserAddressInput("  ")).toBe("https://www.google.com");
  });
});

describe("createBrowserRecord", () => {
  it("normalizes the initial URL and starts with idle state", () => {
    const record = createBrowserRecord({
      browserId: "b1",
      initialUrl: "localhost:8081",
      now: 1000,
    });

    expect(record).toEqual({
      browserId: "b1",
      url: "http://localhost:8081",
      title: "",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastError: null,
      viewport: { mode: "responsive" },
      createdAt: 1000,
    });
  });
});

describe("applyBrowserPatch", () => {
  it("updates the browser's canonical viewport", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    const next = applyBrowserPatch(initial, "b1", {
      viewport: createFixedBrowserViewport(639.6, 479.6),
    });

    expect(next.browsersById.b1?.viewport).toEqual({ mode: "fixed", width: 640, height: 480 });
  });

  it("normalizes URL updates", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    const next = applyBrowserPatch(initial, "b1", { url: "example.com/path" });

    expect(next.browsersById.b1?.url).toBe("https://example.com/path");
  });

  it("returns the same state reference when nothing changes", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    const next = applyBrowserPatch(initial, "b1", { url: "https://a.test", title: "" });

    expect(next).toBe(initial);
  });

  it("returns the same state when the browser id is unknown", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    const next = applyBrowserPatch(initial, "missing", { title: "x" });

    expect(next).toBe(initial);
  });

  it("returns the same state when the browser id is blank", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    expect(applyBrowserPatch(initial, "   ", { title: "x" })).toBe(initial);
  });
});

describe("removeBrowserFromIndex", () => {
  it("removes the named browser", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
      createBrowserRecord({ browserId: "b2", initialUrl: "https://b.test", now: 0 }),
    ]);

    const next = removeBrowserFromIndex(initial, "b1");

    expect(Object.keys(next.browsersById)).toEqual(["b2"]);
  });

  it("returns the same state when the browser id is unknown", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    expect(removeBrowserFromIndex(initial, "missing")).toBe(initial);
  });

  it("returns the same state when the browser id is blank", () => {
    const initial = withRecords([
      createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 }),
    ]);

    expect(removeBrowserFromIndex(initial, "   ")).toBe(initial);
  });
});

describe("sanitizeBrowsersForPersist", () => {
  it("clears transient fields on every record", () => {
    const base = createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 });
    const state: BrowserIndexState = {
      browsersById: {
        b1: { ...base, isLoading: true, lastError: "network down" },
      },
    };

    const persisted = sanitizeBrowsersForPersist(state);

    expect(persisted.browsersById.b1?.isLoading).toBe(false);
    expect(persisted.browsersById.b1?.lastError).toBe(null);
  });

  it("preserves viewport state", () => {
    const base = createBrowserRecord({ browserId: "b1", initialUrl: "https://a.test", now: 0 });
    const state = applyBrowserPatch(withRecords([base]), "b1", {
      viewport: createFixedBrowserViewport(640, 480),
    });

    expect(sanitizeBrowsersForPersist(state).browsersById.b1?.viewport).toEqual({
      mode: "fixed",
      width: 640,
      height: 480,
    });
  });
});

describe("normalizeBrowserIndexState", () => {
  it("defaults legacy persisted records to Responsive", () => {
    const legacy = createBrowserRecord({
      browserId: "b1",
      initialUrl: "https://a.test",
      now: 0,
    }) as Partial<ReturnType<typeof createBrowserRecord>>;
    delete legacy.viewport;

    expect(
      normalizeBrowserIndexState({ browsersById: { b1: legacy } }).browsersById.b1?.viewport,
    ).toEqual({ mode: "responsive" });
  });
});
