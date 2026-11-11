import { describe, expect, test } from "vitest";
import { CdpQueueTimeoutError, CdpSessionQueue } from "./cdp-session-queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("CdpSessionQueue", () => {
  test("runs tasks one at a time in order", async () => {
    const queue = new CdpSessionQueue();
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const releaseFirst = () => {
      order.push("first end");
      resolveFirst();
    };
    const first = queue.run(async () => {
      order.push("first start");
      await firstDone;
    });
    const second = queue.run(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  test("a task that never answers releases the slot at its deadline and names what it ran", async () => {
    const queue = new CdpSessionQueue({ defaultTimeoutMs: 20 });
    const stuck = queue.run(() => never(), { label: "Page.captureScreenshot" });
    const next = queue.run(async () => "click");

    await expect(stuck).rejects.toBeInstanceOf(CdpQueueTimeoutError);
    await expect(stuck).rejects.toThrow(
      "did not answer Page.captureScreenshot within 20ms; later commands on the tab no longer wait for it.",
    );
    await expect(next).resolves.toBe("click");
  });

  test("a caller with longer work passes its own deadline", async () => {
    const queue = new CdpSessionQueue({ defaultTimeoutMs: 10 });
    const long = queue.run(
      async () => {
        await delay(30);
        return "captured";
      },
      { label: "full-page capture", timeoutMs: 200 },
    );
    await expect(long).resolves.toBe("captured");
  });

  test("a late result after the deadline is dropped and does not surface as an unhandled rejection", async () => {
    const queue = new CdpSessionQueue({ defaultTimeoutMs: 10 });
    let rejectLate: (error: Error) => void = () => {};
    const late = queue.run(
      () =>
        new Promise<never>((_, reject) => {
          rejectLate = reject;
        }),
      { label: "Network.getResponseBody" },
    );
    await expect(late).rejects.toBeInstanceOf(CdpQueueTimeoutError);
    rejectLate(new Error("target closed"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(queue.run(async () => "after")).resolves.toBe("after");
  });

  test("a task that throws at once releases the slot", async () => {
    const queue = new CdpSessionQueue();
    await expect(
      queue.run(() => {
        throw new Error("not attached");
      }),
    ).rejects.toThrow("not attached");
    await expect(queue.run(async () => 1)).resolves.toBe(1);
  });
});
