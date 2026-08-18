import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { PushNotificationEventStore } from "./event-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createStore(): PushNotificationEventStore {
  const directory = mkdtempSync(join(tmpdir(), "paseo-push-events-"));
  directories.push(directory);
  return new PushNotificationEventStore(
    join(directory, "push-events.json"),
    pino({ level: "silent" }),
  );
}

describe("PushNotificationEventStore", () => {
  test("does not replay history to a first-time device and catches up a returning cursor", () => {
    const store = createStore();
    const first = store.append({ title: "One", body: "first" });
    const second = store.append({ title: "Two", body: "second" });
    expect(first.payload.data).toMatchObject({
      paseoNotificationEpoch: first.event.epoch,
      paseoNotificationSeq: 1,
    });
    expect(store.catchUp(null)).toEqual({
      epoch: first.event.epoch,
      events: [],
      quarantinedThroughSeq: 2,
    });
    expect(store.catchUp({ epoch: first.event.epoch, seq: 1 }).events).toEqual([second.event]);
  });

  test("persists epoch and sequence across daemon restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-push-restart-"));
    directories.push(directory);
    const path = join(directory, "push-events.json");
    const first = new PushNotificationEventStore(path, pino({ level: "silent" }));
    const event = first.append({ title: "One", body: "first" }).event;
    const reloaded = new PushNotificationEventStore(path, pino({ level: "silent" }));
    expect(reloaded.catchUp({ epoch: event.epoch, seq: 0 }).events).toEqual([event]);
    expect(reloaded.append({ title: "Two", body: "second" }).event.seq).toBe(2);
  });
});
