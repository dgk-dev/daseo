import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { ComposerDraft } from "@getpaseo/protocol/messages";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { ComposerDraftRequestError } from "@getpaseo/client/internal/daemon-client";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Daseo delta 139, acceptance 1: two devices on one agent, the daemon as the only shared store.
function collectDraftUpdates(client: DaemonClient): ComposerDraft[] {
  const updates: ComposerDraft[] = [];
  client.on("composer.draft.update", (event) => {
    updates.push(event.payload.draft);
  });
  return updates;
}

function imagesIn(prompt: AgentPromptInput): Array<{ data: string; mimeType: string }> {
  if (typeof prompt === "string") return [];
  return prompt.flatMap((block) =>
    block.type === "image" && "data" in block
      ? [{ data: block.data, mimeType: block.mimeType }]
      : [],
  );
}

test("a draft written on one device reaches the other, which sends its image without the bytes", async () => {
  const prompts: AgentPromptInput[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({ onStartTurn: (prompt) => prompts.push(prompt) }),
  });
  const phone = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.5.148",
  });
  const mac = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.5.148" });

  try {
    await phone.connect();
    await mac.connect();
    expect(mac.getLastServerInfoMessage()?.features?.composerDraftSync).toBe(true);
    await phone.fetchAgents({ subscribe: { subscriptionId: "phone" } });
    await mac.fetchAgents({ subscribe: { subscriptionId: "mac" } });
    const agent = await phone.createAgent({
      provider: "codex",
      cwd: mkdtempSync(path.join(tmpdir(), "composer-draft-")),
      title: "Draft sync",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });

    const phoneUpdates = collectDraftUpdates(phone);
    const macUpdates = collectDraftUpdates(mac);
    await expect(phone.listComposerDrafts()).resolves.toEqual([]);
    await expect(mac.listComposerDrafts({ agentIds: [agent.id] })).resolves.toEqual([]);

    // The phone types; the Mac receives the text.
    const typed = await phone.setComposerDraft({
      agentId: agent.id,
      text: "이 사진 봐",
      attachments: [],
      clientId: "sync-phone",
    });
    await expect.poll(() => macUpdates.at(-1)?.revision).toBe(typed.revision);
    expect(macUpdates.at(-1)).toMatchObject({ text: "이 사진 봐", clientId: "sync-phone" });
    // The writer gets its own echo, recognisable by its client id.
    await expect.poll(() => phoneUpdates.at(-1)?.clientId).toBe("sync-phone");

    // The phone attaches a photo: uploaded once, referenced by id with a thumbnail.
    const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const upload = await phone.uploadFile({
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      bytes: photoBytes,
      requestId: "photo-1",
    });
    expect(upload.error).toBeNull();
    const uploadId = upload.file!.id;
    // The thumbnail is stored once next to the upload; the draft carries only its size and type.
    const thumbnailBytes = { data: "/9j/thumb", mimeType: "image/jpeg", width: 256, height: 192 };
    await phone.setComposerDraftThumbnail({ uploadId, thumbnail: thumbnailBytes });
    const thumbnail = { mimeType: "image/jpeg", width: 256, height: 192 };
    const attached = await phone.setComposerDraft({
      agentId: agent.id,
      text: "이 사진 봐",
      attachments: [
        {
          id: "img-1",
          kind: "image",
          uploadId,
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          size: 8,
          thumbnail,
        },
      ],
      clientId: "sync-phone",
      baseRevision: typed.revision,
    });
    await expect.poll(() => macUpdates.at(-1)?.revision).toBe(attached.revision);
    expect(macUpdates.at(-1)?.attachments).toEqual([
      {
        id: "img-1",
        kind: "image",
        uploadId,
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        size: 8,
        thumbnail,
      },
    ]);

    expect(JSON.stringify(macUpdates.at(-1))).not.toContain("/9j/thumb");
    await expect(mac.getComposerDraftThumbnail(uploadId)).resolves.toEqual(thumbnailBytes);

    // A reconnect that already holds this revision gets nothing back; a stale one gets the draft.
    await expect(
      mac.listComposerDrafts({ knownRevisions: { [agent.id]: attached.revision } }),
    ).resolves.toEqual([]);
    await expect(
      mac.listComposerDrafts({ knownRevisions: { [agent.id]: typed.revision } }),
    ).resolves.toEqual([macUpdates.at(-1)]);

    // The Mac sends with the upload id; it never had the bytes.
    await mac.sendAgentMessage(agent.id, "이 사진 봐", {
      images: [],
      imageUploads: [{ uploadId, mimeType: "image/jpeg" }],
    });
    await expect.poll(() => prompts.length).toBeGreaterThan(0);
    expect(imagesIn(prompts.at(-1)!)).toEqual([
      { data: Buffer.from(photoBytes).toString("base64"), mimeType: "image/jpeg" },
    ]);

    // The Mac clears the revision it sent; both devices see the empty draft.
    const clearedResult = await mac.clearComposerDraft({
      agentId: agent.id,
      clientId: "sync-mac",
      revision: attached.revision,
    });
    expect(clearedResult.cleared).toBe(true);
    await expect.poll(() => phoneUpdates.at(-1)?.revision).toBe(clearedResult.draft?.revision);
    expect(phoneUpdates.at(-1)).toMatchObject({ text: "", attachments: [], clientId: "sync-mac" });
    await expect.poll(() => macUpdates.at(-1)?.revision).toBe(clearedResult.draft?.revision);

    // Next round: the phone writes while the Mac's send of the older revision is in flight.
    const second = await mac.setComposerDraft({
      agentId: agent.id,
      text: "two",
      attachments: [],
      clientId: "sync-mac",
    });
    const writtenDuringSend = await phone.setComposerDraft({
      agentId: agent.id,
      text: "two, and more",
      attachments: [],
      clientId: "sync-phone",
    });
    const staleClear = await mac.clearComposerDraft({
      agentId: agent.id,
      clientId: "sync-mac",
      revision: second.revision,
    });
    expect(staleClear).toEqual({ draft: writtenDuringSend, cleared: false });
    await expect(mac.listComposerDrafts({ agentIds: [agent.id] })).resolves.toEqual([
      writtenDuringSend,
    ]);

    // Archive keeps the draft; delete removes it.
    await mac.archiveAgent(agent.id);
    await expect(mac.listComposerDrafts({ agentIds: [agent.id] })).resolves.toEqual([
      writtenDuringSend,
    ]);
    await mac.deleteAgent(agent.id);
    await expect.poll(() => mac.listComposerDrafts({ agentIds: [agent.id] })).toEqual([]);
    const refused = await phone
      .setComposerDraft({
        agentId: agent.id,
        text: "late",
        attachments: [],
        clientId: "sync-phone",
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ComposerDraftRequestError);
    expect((refused as ComposerDraftRequestError).code).toBe("agent_not_found");
    const refusedClear = await phone
      .clearComposerDraft({ agentId: agent.id, clientId: "sync-phone", revision: 99 })
      .catch((error: unknown) => error);
    expect((refusedClear as ComposerDraftRequestError).code).toBe("agent_not_found");
  } finally {
    await phone.close();
    await mac.close();
    await daemon.close();
  }
});
