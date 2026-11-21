import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { readUploadThumbnail, writeUploadThumbnail } from "../file-upload/index.js";
import type { ComposerDraftStore } from "./composer-draft-store.js";

/** The client stops syncing a chat the host refused this way (it was deleted). */
export const COMPOSER_DRAFT_AGENT_NOT_FOUND = "agent_not_found";

class AgentNotFoundError extends Error {
  readonly code = COMPOSER_DRAFT_AGENT_NOT_FOUND;
  constructor(agentId: string) {
    super(`Agent ${agentId} does not exist.`);
    this.name = "AgentNotFoundError";
  }
}

function errorCodeOf(error: unknown): string | null {
  return error instanceof AgentNotFoundError ? error.code : null;
}

type ComposerDraftRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "composer.draft.list.request"
      | "composer.draft.set.request"
      | "composer.draft.clear.request"
      | "composer.draft.set_thumbnail.request"
      | "composer.draft.get_thumbnail.request";
  }
>;

interface ComposerDraftSessionChannelOptions {
  /** Absent when the runtime keeps no drafts; the channel then leaves every message. */
  store: ComposerDraftStore | null | undefined;
  paseoHome: string;
  /** Whether a stored (possibly archived) agent exists; drafts of unknown agents are refused. */
  agentExists: (agentId: string) => Promise<boolean>;
  emit: (message: SessionOutboundMessage) => void;
  logger: pino.Logger;
}

/**
 * Daseo delta 139: one session's side of the synced composer drafts. A session receives
 * composer.draft.update only after its first composer.draft.* request, so an app that does not
 * know the feature never gets a message type it cannot parse. Every change is pushed to every
 * subscribed session, the writer's included; the draft carries the writer's client id.
 */
export class ComposerDraftSessionChannel {
  private readonly store: ComposerDraftStore | null;
  private readonly paseoHome: string;
  private readonly agentExists: (agentId: string) => Promise<boolean>;
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(options: ComposerDraftSessionChannelOptions) {
    this.store = options.store ?? null;
    this.paseoHome = options.paseoHome;
    this.agentExists = options.agentExists;
    this.emit = options.emit;
    this.logger = options.logger;
  }

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    const store = this.store;
    if (!store) return undefined;
    if (message.type === "composer.draft.list.request") return this.handleList(store, message);
    if (message.type === "composer.draft.set.request") return this.handleSet(store, message);
    if (message.type === "composer.draft.clear.request") return this.handleClear(store, message);
    if (message.type === "composer.draft.set_thumbnail.request") {
      return this.handleSetThumbnail(message);
    }
    if (message.type === "composer.draft.get_thumbnail.request") {
      return this.handleGetThumbnail(message);
    }
    return undefined;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private subscribe(store: ComposerDraftStore): void {
    if (this.unsubscribe) return;
    this.unsubscribe = store.onChange((draft) => {
      this.emit({ type: "composer.draft.update", payload: { draft } });
    });
  }

  private async handleList(
    store: ComposerDraftStore,
    request: Extract<ComposerDraftRequest, { type: "composer.draft.list.request" }>,
  ): Promise<void> {
    this.subscribe(store);
    try {
      const known = request.knownRevisions ?? {};
      const drafts = (await store.list(request.agentIds)).filter(
        (draft) => known[draft.agentId] !== draft.revision,
      );
      this.emit({
        type: "composer.draft.list.response",
        payload: { requestId: request.requestId, drafts, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list composer drafts");
      this.emit({
        type: "composer.draft.list.response",
        payload: { requestId: request.requestId, drafts: [], error: getErrorMessage(error) },
      });
    }
  }

  private async handleSet(
    store: ComposerDraftStore,
    request: Extract<ComposerDraftRequest, { type: "composer.draft.set.request" }>,
  ): Promise<void> {
    this.subscribe(store);
    try {
      await this.assertAgentExists(request.agentId);
      const draft = await store.set(
        {
          agentId: request.agentId,
          text: request.text,
          attachments: request.attachments,
          clientId: request.clientId,
        },
        this,
      );
      this.emit({
        type: "composer.draft.set.response",
        payload: { requestId: request.requestId, draft, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, agentId: request.agentId }, "Failed to store composer draft");
      this.emit({
        type: "composer.draft.set.response",
        payload: {
          requestId: request.requestId,
          draft: null,
          error: getErrorMessage(error),
          errorCode: errorCodeOf(error),
        },
      });
    }
  }

  private async handleClear(
    store: ComposerDraftStore,
    request: Extract<ComposerDraftRequest, { type: "composer.draft.clear.request" }>,
  ): Promise<void> {
    this.subscribe(store);
    try {
      await this.assertAgentExists(request.agentId);
      const result = await store.clear(
        { agentId: request.agentId, clientId: request.clientId, revision: request.revision },
        this,
      );
      this.emit({
        type: "composer.draft.clear.response",
        payload: { requestId: request.requestId, ...result, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, agentId: request.agentId }, "Failed to clear composer draft");
      this.emit({
        type: "composer.draft.clear.response",
        payload: {
          requestId: request.requestId,
          draft: null,
          cleared: false,
          error: getErrorMessage(error),
          errorCode: errorCodeOf(error),
        },
      });
    }
  }

  private async assertAgentExists(agentId: string): Promise<void> {
    if (!(await this.agentExists(agentId))) throw new AgentNotFoundError(agentId);
  }

  private async handleSetThumbnail(
    request: Extract<ComposerDraftRequest, { type: "composer.draft.set_thumbnail.request" }>,
  ): Promise<void> {
    let error: string | null = null;
    try {
      await writeUploadThumbnail({
        paseoHome: this.paseoHome,
        uploadId: request.uploadId,
        thumbnail: request.thumbnail,
      });
    } catch (caught) {
      error = getErrorMessage(caught);
    }
    this.emit({
      type: "composer.draft.set_thumbnail.response",
      payload: { requestId: request.requestId, error },
    });
  }

  private async handleGetThumbnail(
    request: Extract<ComposerDraftRequest, { type: "composer.draft.get_thumbnail.request" }>,
  ): Promise<void> {
    try {
      const thumbnail = await readUploadThumbnail({
        paseoHome: this.paseoHome,
        uploadId: request.uploadId,
      });
      this.emit({
        type: "composer.draft.get_thumbnail.response",
        payload: { requestId: request.requestId, thumbnail, error: null },
      });
    } catch (error) {
      this.emit({
        type: "composer.draft.get_thumbnail.response",
        payload: { requestId: request.requestId, thumbnail: null, error: getErrorMessage(error) },
      });
    }
  }
}
