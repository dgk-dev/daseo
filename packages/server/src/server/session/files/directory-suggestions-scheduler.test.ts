import { describe, expect, it } from "vitest";
import {
  DirectorySuggestionsScheduler,
  DirectorySuggestionsSupersededError,
} from "./directory-suggestions-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("DirectorySuggestionsScheduler", () => {
  it("runs one search at a time", async () => {
    const scheduler = new DirectorySuggestionsScheduler();
    const order: string[] = [];
    const first = deferred();
    const a = scheduler.run(null, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
      return "a";
    });
    const b = scheduler.run(null, async () => {
      order.push("b:start");
      return "b";
    });
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("aborts the running search of the same group and drops its queued one", async () => {
    const scheduler = new DirectorySuggestionsScheduler();
    const started: string[] = [];
    const running = scheduler.run("picker", (signal) => {
      started.push("first");
      return untilAborted(signal);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first"]);
    const queued = scheduler.run("picker", async () => {
      started.push("second");
      return "second";
    });
    const latest = scheduler.run("picker", async () => {
      started.push("third");
      return "third";
    });

    await expect(running).rejects.toBeInstanceOf(DirectorySuggestionsSupersededError);
    await expect(queued).rejects.toBeInstanceOf(DirectorySuggestionsSupersededError);
    await expect(latest).resolves.toBe("third");
    expect(started).toEqual(["first", "third"]);
  });

  it("never cancels searches without a group or from another group", async () => {
    const scheduler = new DirectorySuggestionsScheduler();
    const lookup = scheduler.run(null, async () => "lookup");
    const other = scheduler.run("other", async () => "other");
    const picker = scheduler.run("picker", async () => "picker");
    const nextLookup = scheduler.run(null, async () => "next lookup");

    await expect(Promise.all([lookup, other, picker, nextLookup])).resolves.toEqual([
      "lookup",
      "other",
      "picker",
      "next lookup",
    ]);
  });
});
