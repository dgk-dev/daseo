import { describe, expect, test } from "vitest";
import { ComposerOutboxStore, type ComposerOutboxStorage } from "./store";

function createStorage(): ComposerOutboxStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

describe("ComposerOutboxStore", () => {
  test("persists an attachment-aware queue item before exposing it", async () => {
    const storage = createStorage();
    const store = new ComposerOutboxStore(storage);
    const attachment = {
      kind: "image" as const,
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "native-file" as const,
        storageKey: "/tmp/image-1.png",
        createdAt: 1,
      },
    };

    await store.enqueue({
      id: "message-1",
      serverId: "server-1",
      agentId: "agent-1",
      text: "inspect",
      attachments: [attachment],
      intent: "queued",
      now: 10,
    });

    expect(storage.values.size).toBe(1);
    const reloaded = new ComposerOutboxStore(storage);
    expect(await reloaded.list()).toEqual([
      {
        version: 1,
        id: "message-1",
        serverId: "server-1",
        agentId: "agent-1",
        text: "inspect",
        attachments: [attachment],
        intent: "queued",
        status: "queued",
        createdAt: 10,
        updatedAt: 10,
        attemptCount: 0,
        lastError: null,
      },
    ]);
    expect(await reloaded.collectAttachmentIds()).toEqual(new Set(["image-1"]));
  });

  test("serializes mutations and keeps the same id bound to one payload", async () => {
    const storage = createStorage();
    const store = new ComposerOutboxStore(storage);
    await Promise.all([
      store.enqueue({
        id: "message-1",
        serverId: "server-1",
        agentId: "agent-1",
        text: "one",
        attachments: [],
        intent: "dispatch",
        now: 1,
      }),
      store.enqueue({
        id: "message-2",
        serverId: "server-1",
        agentId: "agent-1",
        text: "two",
        attachments: [],
        intent: "dispatch",
        now: 2,
      }),
    ]);
    expect((await store.list()).map((record) => record.id)).toEqual(["message-1", "message-2"]);
    await expect(
      store.enqueue({
        id: "message-1",
        serverId: "server-1",
        agentId: "agent-1",
        text: "changed",
        attachments: [],
        intent: "dispatch",
      }),
    ).rejects.toThrow("already belongs to another payload");
  });

  test("rekeys placeholder hosts and preserves delivery-unknown state", async () => {
    const storage = createStorage();
    const store = new ComposerOutboxStore(storage);
    await store.enqueue({
      id: "message-1",
      serverId: "local:6767",
      agentId: "agent-1",
      text: "one",
      attachments: [],
      intent: "dispatch",
      now: 1,
    });
    await store.mark({
      serverId: "local:6767",
      id: "message-1",
      status: "delivery_unknown",
      incrementAttempt: true,
      lastError: "socket closed",
      now: 2,
    });
    await store.rekeyServerId("local:6767", "server-real");

    expect(await store.list()).toMatchObject([
      {
        serverId: "server-real",
        status: "delivery_unknown",
        attemptCount: 1,
        lastError: "socket closed",
      },
    ]);
  });
});
