import { describe, expect, test } from "vitest";
import {
  createRemoteStreamWatch,
  type RemoteStreamStatus,
  type RemoteStreamWatchScheduler,
} from "./remote-stream-watch";

const FIRST_FRAME_TIMEOUT_MS = 8_000;

class FakeScheduler implements RemoteStreamWatchScheduler {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.now).sort((a, b) => a - b);
  }

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await flush();
    }
    this.now = until;
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(input: { watchResults: Array<Promise<boolean> | boolean>; retained?: boolean }) {
  const scheduler = new FakeScheduler();
  const statuses: RemoteStreamStatus[] = [];
  const calls: string[] = [];
  const results = [...input.watchResults];
  const watch = createRemoteStreamWatch({
    watch: () => {
      calls.push("watch");
      return Promise.resolve(results.shift() ?? true);
    },
    unwatch: () => {
      calls.push("unwatch");
      return Promise.resolve();
    },
    onStatus: (status) => statuses.push(status),
    hasRetainedFrame: input.retained ?? false,
    firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
    scheduler,
  });
  return { scheduler, statuses, calls, watch };
}

describe("remote browser stream watch", () => {
  test("a frame that arrives before the watch response keeps a static page live", async () => {
    const response = deferred<boolean>();
    const { scheduler, statuses, calls, watch } = setup({ watchResults: [response.promise] });

    watch.start();
    expect(watch.acceptFrame(1)).toBe(true);
    response.resolve(true);
    await flush();
    await scheduler.advance(30_000);

    expect(statuses).toEqual(["connecting", "live"]);
    expect(calls).toEqual(["watch"]);
    expect(scheduler.pendingDelays()).toEqual([]);
  });

  test("retries when the first frame never comes, then goes live on the rewatch's frame", async () => {
    const { scheduler, statuses, calls, watch } = setup({ watchResults: [true, true] });

    watch.start();
    await flush();
    expect(scheduler.pendingDelays()).toEqual([FIRST_FRAME_TIMEOUT_MS]);
    await scheduler.advance(FIRST_FRAME_TIMEOUT_MS);
    expect(statuses).toEqual(["connecting", "retrying"]);
    await scheduler.advance(500);
    expect(calls).toEqual(["watch", "unwatch", "watch"]);
    expect(watch.acceptFrame(1)).toBe(true);
    expect(statuses).toEqual(["connecting", "retrying", "live"]);
    expect(scheduler.pendingDelays()).toEqual([]);
  });

  test("a real recovery restores the full retry budget", async () => {
    const third = deferred<boolean>();
    const { scheduler, statuses, watch } = setup({
      watchResults: [false, false, third.promise, false],
    });

    watch.start();
    await flush();
    // Two refusals use the 500 ms and 1 s slots; the third watch is still in flight.
    await scheduler.advance(500 + 1_000);
    expect(watch.acceptFrame(1)).toBe(true);
    expect(statuses.at(-1)).toBe("live");

    // The next outage starts again from the first slot, not from the 2 s slot.
    third.resolve(false);
    await flush();
    expect(statuses.at(-1)).toBe("retrying");
    expect(scheduler.pendingDelays()).toEqual([500]);
  });

  test("drops duplicate and stale frames without reporting a status change", async () => {
    const { statuses, watch } = setup({ watchResults: [true] });

    watch.start();
    await flush();
    expect(watch.acceptFrame(5)).toBe(true);
    expect(watch.acceptFrame(5)).toBe(false);
    expect(watch.acceptFrame(4)).toBe(false);
    expect(watch.acceptFrame(6)).toBe(true);
    expect(statuses).toEqual(["connecting", "live"]);
  });

  test("startup over a retained frame reads as a retry, and dispose unwatches once", async () => {
    const { scheduler, statuses, calls, watch } = setup({ watchResults: [true], retained: true });

    watch.start();
    await flush();
    watch.dispose();
    watch.dispose();
    await flush();

    expect(statuses).toEqual(["retrying"]);
    expect(calls).toEqual(["watch", "unwatch"]);
    expect(scheduler.pendingDelays()).toEqual([]);
    expect(watch.acceptFrame(1)).toBe(false);
  });
});
