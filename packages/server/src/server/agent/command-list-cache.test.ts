import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AgentSlashCommand } from "./agent-sdk-types.js";
import { CommandListCache } from "./command-list-cache.js";

const logger = pino({ level: "silent" });
const KEY = { provider: "pi", cwd: "/repo" };
const LIST_A: AgentSlashCommand[] = [{ name: "a", description: "A", argumentHint: "" }];
const LIST_B: AgentSlashCommand[] = [
  { name: "b", description: "B", argumentHint: "<x>", kind: "skill" },
];

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-command-lists-"));
}

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function createClock(start = 1_000_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function countingCompute(result: AgentSlashCommand[]) {
  const calls = { count: 0 };
  const compute = async () => {
    calls.count += 1;
    return result;
  };
  return { calls, compute };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("CommandListCache (delta 138)", () => {
  it("computes on a miss and answers the next request from the cache", async () => {
    const cache = new CommandListCache({ filePath: null, logger });
    const { calls, compute } = countingCompute(LIST_A);

    await expect(cache.resolve(KEY, compute)).resolves.toEqual(LIST_A);
    await expect(cache.resolve(KEY, compute)).resolves.toEqual(LIST_A);

    expect(calls.count).toBe(1);
  });

  it("keys by provider and resolved cwd only", async () => {
    const cache = new CommandListCache({ filePath: null, logger });
    await cache.store({ provider: "pi", cwd: "/repo/sub/.." }, LIST_A);
    const other = countingCompute(LIST_B);

    await expect(cache.resolve({ provider: "pi", cwd: "/repo" }, other.compute)).resolves.toEqual(
      LIST_A,
    );
    await expect(
      cache.resolve({ provider: "claude", cwd: "/repo" }, other.compute),
    ).resolves.toEqual(LIST_B);
    expect(other.calls.count).toBe(1);
  });

  it("shares one computation between concurrent misses for the same key", async () => {
    const cache = new CommandListCache({ filePath: null, logger });
    const pending = deferred<AgentSlashCommand[]>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return pending.promise;
    };

    const first = cache.resolve(KEY, compute);
    const second = cache.resolve(KEY, compute);
    await settle();
    pending.resolve(LIST_A);

    await expect(first).resolves.toEqual(LIST_A);
    await expect(second).resolves.toEqual(LIST_A);
    expect(calls).toBe(1);
  });

  it("does not cache a failed miss", async () => {
    const cache = new CommandListCache({ filePath: null, logger });

    await expect(
      cache.resolve(KEY, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    await expect(cache.resolve(KEY, async () => LIST_A)).resolves.toEqual(LIST_A);
  });

  it("refreshes in the background at most once per interval and keeps the old list on failure", async () => {
    const clock = createClock();
    const cache = new CommandListCache({
      filePath: null,
      logger,
      now: clock.now,
      refreshIntervalMs: 1000,
    });
    await cache.store(KEY, LIST_A);

    let refreshCalls = 0;
    const failing = async (): Promise<AgentSlashCommand[]> => {
      refreshCalls += 1;
      throw new Error("refresh failed");
    };

    // Fresh: no refresh.
    await expect(cache.resolve(KEY, failing)).resolves.toEqual(LIST_A);
    expect(refreshCalls).toBe(0);

    // Due: answers the cached list at once and refreshes once.
    clock.advance(1000);
    await expect(cache.resolve(KEY, failing)).resolves.toEqual(LIST_A);
    await settle();
    expect(refreshCalls).toBe(1);

    // The failed attempt counts toward the interval.
    await expect(cache.resolve(KEY, failing)).resolves.toEqual(LIST_A);
    await settle();
    expect(refreshCalls).toBe(1);

    // Next interval: a successful refresh replaces the list.
    clock.advance(1000);
    const refresh = countingCompute(LIST_B);
    await expect(cache.resolve(KEY, refresh.compute)).resolves.toEqual(LIST_A);
    await settle();
    expect(refresh.calls.count).toBe(1);
    await expect(cache.resolve(KEY, refresh.compute)).resolves.toEqual(LIST_B);
    expect(refresh.calls.count).toBe(1);
  });

  it("runs a single background refresh while one is in flight", async () => {
    const clock = createClock();
    const cache = new CommandListCache({
      filePath: null,
      logger,
      now: clock.now,
      refreshIntervalMs: 1000,
    });
    await cache.store(KEY, LIST_A);
    clock.advance(5000);

    const pending = deferred<AgentSlashCommand[]>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return pending.promise;
    };
    await cache.resolve(KEY, compute);
    clock.advance(5000);
    await cache.resolve(KEY, compute);
    expect(calls).toBe(1);
    pending.resolve(LIST_B);
    await settle();
    await expect(cache.resolve(KEY, compute)).resolves.toEqual(LIST_B);
  });

  it("keeps lists across a restart", async () => {
    const home = createHome();
    const filePath = path.join(home, "command-lists.json");
    const first = new CommandListCache({ filePath, logger });
    await first.store(KEY, LIST_A);
    await first.store({ provider: "claude", cwd: "/other" }, LIST_B);
    await first.flush();

    const second = new CommandListCache({ filePath, logger });
    const { calls, compute } = countingCompute([]);
    await expect(second.resolve(KEY, compute)).resolves.toEqual(LIST_A);
    await expect(second.resolve({ provider: "claude", cwd: "/other" }, compute)).resolves.toEqual(
      LIST_B,
    );
    expect(calls.count).toBe(0);

    const stored = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      entries: Array<{ provider: string; cwd: string }>;
    };
    expect(stored.version).toBe(1);
    expect(stored.entries.map((entry) => entry.provider)).toEqual(["claude", "pi"]);
  });

  it("starts empty from a corrupt file and keeps a copy of it", async () => {
    const home = createHome();
    const filePath = path.join(home, "command-lists.json");
    writeFileSync(filePath, "{not json");

    const cache = new CommandListCache({ filePath, logger });
    await expect(cache.resolve(KEY, async () => LIST_A)).resolves.toEqual(LIST_A);
    await cache.flush();

    expect(readdirSync(home).some((name) => name.startsWith("command-lists.json.corrupt-"))).toBe(
      true,
    );
    const reread = new CommandListCache({ filePath, logger });
    const { calls, compute } = countingCompute([]);
    await expect(reread.resolve(KEY, compute)).resolves.toEqual(LIST_A);
    expect(calls.count).toBe(0);
  });

  it("keeps only the most recently used keys", async () => {
    const home = createHome();
    const filePath = path.join(home, "command-lists.json");
    const cache = new CommandListCache({ filePath, logger, maxEntries: 2 });
    await cache.store({ provider: "pi", cwd: "/one" }, LIST_A);
    await cache.store({ provider: "pi", cwd: "/two" }, LIST_A);
    // Using /one makes /two the least recently used.
    await cache.resolve({ provider: "pi", cwd: "/one" }, async () => LIST_B);
    await cache.store({ provider: "pi", cwd: "/three" }, LIST_A);
    await cache.flush();

    const { calls, compute } = countingCompute(LIST_B);
    await expect(cache.resolve({ provider: "pi", cwd: "/two" }, compute)).resolves.toEqual(LIST_B);
    expect(calls.count).toBe(1);
    await cache.flush();

    const reread = new CommandListCache({ filePath, logger, maxEntries: 2 });
    const rereadCompute = countingCompute([]);
    await expect(
      reread.resolve({ provider: "pi", cwd: "/three" }, rereadCompute.compute),
    ).resolves.toEqual(LIST_A);
    expect(rereadCompute.calls.count).toBe(0);
  });
});
