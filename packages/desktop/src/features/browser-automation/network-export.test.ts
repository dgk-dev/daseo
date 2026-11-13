import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabNetworkCapture } from "./network-capture.js";
import {
  defaultExportFileName,
  exportNetworkCapture,
  NetworkExportRefusal,
  writeHarFile,
} from "./network-export.js";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "daseo-har-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function capturedTab(withRequest: boolean): Promise<TabNetworkCapture> {
  const capture = new TabNetworkCapture({
    sendCommand: async (method) =>
      method === "Network.getResponseBody"
        ? { body: '{"token":"tok_0123456789","ok":true}', base64Encoded: false }
        : {},
  });
  await capture.start();
  if (withRequest) {
    const events: Array<[string, Record<string, unknown>]> = [
      [
        "Network.requestWillBeSent",
        {
          requestId: "a",
          request: {
            url: "https://api.shop.test/v1/session",
            method: "GET",
            headers: { Authorization: "Bearer tok_0123456789" },
          },
          type: "Fetch",
          timestamp: 10,
          wallTime: 1_700_000_000,
        },
      ],
      [
        "Network.responseReceived",
        { requestId: "a", response: { status: 200, mimeType: "application/json", headers: {} } },
      ],
      ["Network.loadingFinished", { requestId: "a", timestamp: 10.1 }],
    ];
    for (const [method, params] of events) capture.handleDebuggerMessage(method, params);
  }
  return capture;
}

const ARGS = {
  browserId: "11111111-1111-4111-8111-111111111111",
  bodies: "api" as const,
  includeWebSocket: true,
  overwrite: false,
};

function environment() {
  return {
    appVersion: "0.5.114",
    browserVersion: "146.0.0.0",
    defaultDirectory: join(directory, "Downloads", "Daseo"),
    now: () => new Date(2026, 10, 13, 9, 5, 7),
  };
}

describe("exportNetworkCapture", () => {
  it("writes a sanitized HAR with mode 0600 to the default folder and summarizes it", async () => {
    const summary = await exportNetworkCapture({
      capture: await capturedTab(true),
      args: ARGS,
      pageUrl: "https://www.shop.test/cart",
      environment: environment(),
    });
    const path = join(directory, "Downloads", "Daseo", "network-www.shop.test-20261113-090507.har");
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as {
      log: { entries: Array<{ request: { headers: unknown } }>; comment: string };
    };

    expect(summary).toMatchObject({
      path,
      bytes: Buffer.byteLength(text),
      entries: 1,
      pages: 0,
      pendingCount: 0,
      bodies: { embedded: 1, truncated: 0 },
      redactions: { headers: 1, bodyFields: 1 },
      hosts: [{ host: "api.shop.test", requests: 1 }],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(text).not.toContain("tok_0123456789");
    expect(parsed.log.entries[0]?.request.headers).toEqual([
      { name: "Authorization", value: "Bearer <redacted-1>" },
    ]);
    expect(parsed.log.comment).toContain("Sanitized by Daseo");
    expect(await readdir(join(directory, "Downloads", "Daseo"))).toEqual([
      "network-www.shop.test-20261113-090507.har",
    ]);
  });

  it("picks the next free default name instead of replacing an earlier export", async () => {
    const run = async () =>
      exportNetworkCapture({
        capture: await capturedTab(true),
        args: ARGS,
        pageUrl: "https://www.shop.test/",
        environment: environment(),
      });
    const first = await run();
    const second = await run();

    expect([first.path, second.path].map((path) => path?.split("/").at(-1))).toEqual([
      "network-www.shop.test-20261113-090507.har",
      "network-www.shop.test-20261113-090507-2.har",
    ]);
  });

  it("writes nothing for an empty capture and says how many requests are in flight", async () => {
    const summary = await exportNetworkCapture({
      capture: await capturedTab(false),
      args: ARGS,
      pageUrl: "https://www.shop.test/",
      environment: environment(),
    });

    expect(summary).toMatchObject({ entries: 0, bytes: 0, pendingCount: 0 });
    expect(summary.path).toBeUndefined();
    await expect(stat(join(directory, "Downloads"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("writeHarFile", () => {
  it("creates parent folders and refuses to replace a file without overwrite", async () => {
    const target = join(directory, "deep", "er", "capture.har");
    await writeHarFile(target, "one", false);

    await expect(writeHarFile(target, "two", false)).rejects.toBeInstanceOf(NetworkExportRefusal);
    expect(await readFile(target, "utf8")).toBe("one");
    await writeHarFile(target, "three", true);
    expect(await readFile(target, "utf8")).toBe("three");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, "deep", "er"))).toEqual(["capture.har"]);
  });

  it("refuses a directory even with overwrite", async () => {
    const target = join(directory, "folder");
    await mkdir(target);

    await expect(writeHarFile(target, "x", true)).rejects.toThrow(/is a directory/);
  });

  it("leaves no temporary file when a concurrent write wins the name", async () => {
    const target = join(directory, "race.har");
    const results = await Promise.allSettled([
      writeHarFile(target, "first", false),
      writeHarFile(target, "second", false),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && "reason" in rejected ? rejected.reason : null).toBeInstanceOf(
      NetworkExportRefusal,
    );
    expect(await readdir(directory)).toEqual(["race.har"]);
  });

  it("removes the temporary file when the write itself fails", async () => {
    const blocker = join(directory, "not-a-folder");
    await writeFile(blocker, "file");

    await expect(writeHarFile(join(blocker, "x.har"), "x", false)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(await readdir(directory)).toEqual(["not-a-folder"]);
  });
});

describe("defaultExportFileName", () => {
  it("names the file after the page host and local time", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    expect(defaultExportFileName("https://m.shop.test:8443/a", now)).toBe(
      "network-m.shop.test-20260102-030405.har",
    );
    expect(defaultExportFileName("about:blank", now, 3)).toBe("network-page-20260102-030405-3.har");
  });
});
