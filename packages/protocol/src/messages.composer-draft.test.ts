import { describe, expect, it } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

// Daseo delta 139: composer drafts kept by the daemon.
const imageAttachment = {
  id: "att-1",
  kind: "image",
  uploadId: "upload_req-1",
  fileName: "photo.jpg",
  mimeType: "image/jpeg",
  size: 123_456,
  thumbnail: { mimeType: "image/jpeg", width: 256, height: 192 },
};
const thumbnail = { data: "AAAA", mimeType: "image/jpeg", width: 256, height: 192 };

const storedDraft = {
  agentId: "agent-1",
  text: "안녕",
  attachments: [imageAttachment, { id: "ws:src/a.ts", kind: "workspace_file", data: "{}" }],
  revision: 3,
  updatedAt: 1_763_700_000_000,
  clientId: "sync-phone",
};

describe("composer draft messages", () => {
  it("parses the three requests a client sends", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "composer.draft.list.request",
        requestId: "r1",
      }),
    ).toEqual({ type: "composer.draft.list.request", requestId: "r1" });
    const set = {
      type: "composer.draft.set.request",
      requestId: "r2",
      agentId: "agent-1",
      text: "hi",
      attachments: [imageAttachment],
      clientId: "sync-mac",
      baseRevision: 2,
    };
    expect(SessionInboundMessageSchema.parse(set)).toEqual(set);
    const clear = {
      type: "composer.draft.clear.request",
      requestId: "r3",
      agentId: "agent-1",
      clientId: "sync-mac",
      revision: 3,
    };
    expect(SessionInboundMessageSchema.parse(clear)).toEqual(clear);
    const known = {
      type: "composer.draft.list.request",
      requestId: "r4",
      knownRevisions: { "agent-1": 3 },
    };
    expect(SessionInboundMessageSchema.parse(known)).toEqual(known);
    const setThumbnail = {
      type: "composer.draft.set_thumbnail.request",
      requestId: "r5",
      uploadId: "upload_req-1",
      thumbnail,
    };
    expect(SessionInboundMessageSchema.parse(setThumbnail)).toEqual(setThumbnail);
    const getThumbnail = {
      type: "composer.draft.get_thumbnail.request",
      requestId: "r6",
      uploadId: "upload_req-1",
    };
    expect(SessionInboundMessageSchema.parse(getThumbnail)).toEqual(getThumbnail);
  });

  it("validates every daemon answer and the push on the client's generated validator", () => {
    const messages = [
      {
        type: "composer.draft.list.response",
        payload: { requestId: "r1", drafts: [storedDraft], error: null },
      },
      {
        type: "composer.draft.set.response",
        payload: { requestId: "r2", draft: storedDraft, error: null },
      },
      {
        type: "composer.draft.clear.response",
        payload: { requestId: "r3", draft: null, cleared: true, error: null },
      },
      {
        type: "composer.draft.set.response",
        payload: {
          requestId: "r7",
          draft: null,
          error: "Agent agent-9 does not exist.",
          errorCode: "agent_not_found",
        },
      },
      {
        type: "composer.draft.set_thumbnail.response",
        payload: { requestId: "r5", error: null },
      },
      {
        type: "composer.draft.get_thumbnail.response",
        payload: { requestId: "r6", thumbnail, error: null },
      },
      { type: "composer.draft.update", payload: { draft: storedDraft } },
    ];
    for (const message of messages) {
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
  });

  it("accepts an attachment that carries only the fields a later app sends", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "composer.draft.update",
      payload: {
        draft: { ...storedDraft, attachments: [{ id: "x", kind: "plugin_resource_v2" }] },
      },
    });
    expect(parsed.type).toBe("composer.draft.update");
  });

  it("reads the feature flag as absent on an older daemon", () => {
    const features = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: {},
    }).features;
    expect(features?.composerDraftSync).toBeUndefined();
    const current = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv",
      features: { composerDraftSync: true },
    }).features;
    expect(current?.composerDraftSync).toBe(true);
  });
});
