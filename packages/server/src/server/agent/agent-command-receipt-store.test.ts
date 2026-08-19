import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import {
  AgentCommandReceiptStore,
  hashAgentCommandPayload,
} from "./agent-command-receipt-store.js";

const logger = pino({ level: "silent" });

describe("AgentCommandReceiptStore", () => {
  test("persists admission before returning and replays the accepted receipt", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-command-receipts-"));
    const store = new AgentCommandReceiptStore(paseoHome, logger);
    const payloadHash = hashAgentCommandPayload({
      agentId: "agent-1",
      text: "ship it",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      attachments: [{ type: "text", text: "context" }],
    });

    await expect(
      store.admit({
        commandId: "command-1",
        agentId: "agent-1",
        payloadHash,
        now: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ kind: "new", receipt: { status: "in_flight" } });

    const onDisk = JSON.parse(
      await readFile(join(paseoHome, "agent-command-receipts.json"), "utf8"),
    ) as { receipts: Array<{ commandId: string; status: string }> };
    expect(onDisk.receipts).toMatchObject([{ commandId: "command-1", status: "in_flight" }]);

    await store.settle({
      commandId: "command-1",
      status: "accepted",
      now: new Date("2026-08-18T00:00:01.000Z"),
    });
    const reloaded = new AgentCommandReceiptStore(paseoHome, logger);
    await expect(
      reloaded.admit({ commandId: "command-1", agentId: "agent-1", payloadHash }),
    ).resolves.toMatchObject({ kind: "existing", receipt: { status: "accepted" } });
  });

  test("rejects reuse of one command id for a different target or payload", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-command-receipt-conflict-"));
    const store = new AgentCommandReceiptStore(paseoHome, logger);
    const firstHash = hashAgentCommandPayload({ agentId: "agent-1", text: "first" });
    await store.admit({ commandId: "same-id", agentId: "agent-1", payloadHash: firstHash });

    const secondHash = hashAgentCommandPayload({ agentId: "agent-1", text: "second" });
    await expect(
      store.admit({ commandId: "same-id", agentId: "agent-1", payloadHash: secondHash }),
    ).resolves.toMatchObject({ kind: "conflict", receipt: { payloadHash: firstHash } });
    await expect(
      store.admit({ commandId: "same-id", agentId: "agent-2", payloadHash: firstHash }),
    ).resolves.toMatchObject({ kind: "conflict", receipt: { agentId: "agent-1" } });
  });

  test("requires an explicit resolution before retrying an ambiguous command", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-command-receipt-resolution-"));
    const store = new AgentCommandReceiptStore(paseoHome, logger);
    const payloadHash = hashAgentCommandPayload({ agentId: "agent-1", text: "ambiguous" });
    await store.admit({ commandId: "retry-id", agentId: "agent-1", payloadHash });

    await expect(store.resolve({ commandId: "retry-id", action: "retry" })).resolves.toMatchObject({
      status: "retry_ready",
      receipt: { status: "in_flight" },
    });
    await expect(
      store.admit({ commandId: "retry-id", agentId: "agent-1", payloadHash }),
    ).resolves.toMatchObject({ kind: "new", receipt: { status: "in_flight" } });

    await expect(
      store.resolve({ commandId: "retry-id", action: "discard" }),
    ).resolves.toMatchObject({ status: "rejected", receipt: { error: "Discarded by operator" } });
    await expect(store.get("retry-id")).resolves.toMatchObject({ status: "rejected" });

    await store.settle({ commandId: "retry-id", status: "accepted" });
    await expect(store.resolve({ commandId: "retry-id", action: "retry" })).resolves.toMatchObject({
      status: "accepted",
      receipt: { status: "accepted" },
    });
    await expect(store.resolve({ commandId: "missing-id", action: "retry" })).resolves.toEqual({
      status: "retry_ready",
      receipt: null,
    });
  });

  test("hashes object keys deterministically while preserving image and text identity", () => {
    const left = hashAgentCommandPayload({
      agentId: "agent-1",
      text: "hello",
      attachments: [{ type: "text", text: "body", title: "title" }],
    });
    const reordered = hashAgentCommandPayload({
      agentId: "agent-1",
      text: "hello",
      attachments: [{ title: "title", text: "body", type: "text" }],
    });
    const changed = hashAgentCommandPayload({
      agentId: "agent-1",
      text: "hello!",
      attachments: [{ title: "title", text: "body", type: "text" }],
    });

    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
  });
});
