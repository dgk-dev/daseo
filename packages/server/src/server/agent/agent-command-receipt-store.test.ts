import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import {
  AgentCommandReceiptStore,
  hashAgentCommandPayload,
} from "./agent-command-receipt-store.js";

const logger = pino({ level: "silent" });

// Reloading a store prunes settled receipts older than 30 days by the real clock, so fixtures that
// reload must stay recent; a fixed calendar date would rot.
function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1_000);
}

describe("AgentCommandReceiptStore", () => {
  test("keeps a schema-invalid receipt file as a backup and stays usable", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-command-receipt-corrupt-"));
    const filePath = join(paseoHome, "agent-command-receipts.json");
    const invalid = JSON.stringify({ version: 1, receipts: [{ commandId: "" }] });
    await writeFile(filePath, invalid);
    const store = new AgentCommandReceiptStore(paseoHome, logger);

    await expect(
      store.admit({ commandId: "command-1", agentId: "agent-1", payloadHash: "hash" }),
    ).resolves.toMatchObject({ kind: "new" });

    const backups = (await readdir(paseoHome)).filter((entry) =>
      entry.startsWith("agent-command-receipts.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(paseoHome, backups[0]!), "utf8")).toBe(invalid);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      receipts: [{ commandId: "command-1" }],
    });
  });

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
        now: secondsAgo(60),
      }),
    ).resolves.toMatchObject({ kind: "new", receipt: { status: "in_flight" } });

    const onDisk = JSON.parse(
      await readFile(join(paseoHome, "agent-command-receipts.json"), "utf8"),
    ) as { receipts: Array<{ commandId: string; status: string }> };
    expect(onDisk.receipts).toMatchObject([{ commandId: "command-1", status: "in_flight" }]);

    await store.settle({
      commandId: "command-1",
      status: "accepted",
      now: secondsAgo(59),
    });
    const reloaded = new AgentCommandReceiptStore(paseoHome, logger);
    await expect(
      reloaded.admit({ commandId: "command-1", agentId: "agent-1", payloadHash }),
    ).resolves.toMatchObject({ kind: "existing", receipt: { status: "accepted" } });
  });

  test("rejects persisted in-flight receipts after a daemon restart", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-command-receipt-restart-"));
    const store = new AgentCommandReceiptStore(paseoHome, logger);
    const payloadHash = hashAgentCommandPayload({ agentId: "agent-1", text: "interrupted" });
    await store.admit({
      commandId: "interrupted-command",
      agentId: "agent-1",
      payloadHash,
      now: secondsAgo(60),
    });

    const reloaded = new AgentCommandReceiptStore(paseoHome, logger);

    await expect(reloaded.get("interrupted-command")).resolves.toMatchObject({
      status: "rejected",
      error: "Daemon restarted before command confirmation",
    });
    const onDisk = JSON.parse(
      await readFile(join(paseoHome, "agent-command-receipts.json"), "utf8"),
    ) as { receipts: Array<{ commandId: string; status: string; error: string | null }> };
    expect(onDisk.receipts).toContainEqual(
      expect.objectContaining({
        commandId: "interrupted-command",
        status: "rejected",
        error: "Daemon restarted before command confirmation",
      }),
    );
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
