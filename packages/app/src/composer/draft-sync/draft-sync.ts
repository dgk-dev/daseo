import {
  ComposerDraftRequestError,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { ComposerDraft } from "@getpaseo/protocol/messages";
import type { HostThumbnailFetcher } from "@/attachments/host-upload-thumbnails";
import type { AttachmentMetadata, HostUploadReference } from "@/attachments/types";
import type { ComposerActivitySource } from "@/composer/draft-sync/composer-activity";
import {
  fromWireDraft,
  isEmptyWireDraft,
  toWireDraft,
  wireDraftKey,
  type WireDraft,
} from "@/composer/draft-sync/wire";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { DraftInput } from "@/stores/draft-store/state";

/**
 * Daseo delta 139: keeps the unsent draft of every existing agent chat (`agent:<serverId>:<id>`
 * keys) the same on every device through the daemon of each host that advertises
 * `composerDraftSync`. The local draft store stays what the composer renders and edits; it keeps
 * working offline, and this module moves drafts between it and the daemon.
 *
 * - Local edits go to the daemon 400 ms after the last change (last writer wins). An emptied draft
 *   is a conditional clear of the revision this device last saw, so a send never erases text
 *   written meanwhile on another device; that text comes back here instead.
 * - Images are uploaded once, when attached; the thumbnail is stored once next to the upload and
 *   the draft carries only the upload id and the thumbnail's size, so a text change moves no image
 *   bytes. Other devices fetch a thumbnail by upload id when they show it.
 * - A draft from another device is applied at once unless the owner is writing in that chat's
 *   composer here (`ComposerActivitySource.isBusy`); it then waits until he stops and is applied
 *   only if it is still newer than what this device stored. A device ignores its own echo.
 * - On (re)connect the daemon's drafts and the local ones are reconciled: the same content adopts
 *   the daemon revision; otherwise a local draft changed since the last sync and written later
 *   than the daemon's wins and is uploaded, else the daemon's is applied. The listing names the
 *   revisions this process already holds, so the daemon sends only drafts that changed.
 * - A chat the host refuses as deleted (`agent_not_found`) is not synced again in this process,
 *   and images are uploaded only for chats the host has accepted.
 */
export type ComposerDraftSyncClient = Pick<
  DaemonClient,
  | "listComposerDrafts"
  | "setComposerDraft"
  | "clearComposerDraft"
  | "setComposerDraftThumbnail"
  | "getComposerDraftThumbnail"
  | "on"
  | "uploadFile"
>;

export interface LocalDraftState {
  /** The active draft, or undefined when there is none (never written, cleared, or sent). */
  draft: DraftInput | undefined;
  /** When the local record last changed (this device's clock); 0 without a record. */
  updatedAt: number;
}

export interface ComposerDraftSyncDeps {
  /** This app instance; the daemon echoes it back on this instance's own writes. */
  clientId: string;
  readLocal: (draftKey: string) => LocalDraftState;
  /** Draft keys that have a local record. */
  listLocalKeys: () => string[];
  /** Replaces the local draft with one from another device and refreshes the editor. */
  applyRemote: (draftKey: string, draft: DraftInput) => void;
  /** Adds the host upload to a local image once its attach-time upload finished. */
  attachHostUpload: (draftKey: string, attachmentId: string, upload: HostUploadReference) => void;
  /** Calls back with the keys whose local record changed. */
  subscribeLocal: (listener: (draftKeys: string[]) => void) => () => void;
  /** Resolves once the persisted local drafts have been read from storage. */
  whenLocalReady: () => Promise<void>;
  activity: ComposerActivitySource;
  /** Makes thumbnails of `serverId`'s uploads fetchable while it is attached. */
  registerThumbnailSource: (serverId: string, fetcher: HostThumbnailFetcher) => () => void;
  /** Encodes and uploads one local image, and stores its thumbnail on the host. */
  uploadImage: (
    client: ComposerDraftSyncClient,
    attachment: AttachmentMetadata,
  ) => Promise<HostUploadReference>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  warn: (message: string, error: unknown) => void;
}

export const DRAFT_PUSH_DEBOUNCE_MS = 400;

interface Host {
  client: ComposerDraftSyncClient;
  ready: boolean;
  unsubscribe: () => void;
}

const AGENT_NOT_FOUND = "agent_not_found";

function isAgentNotFound(error: unknown): boolean {
  return error instanceof ComposerDraftRequestError && error.code === AGENT_NOT_FOUND;
}

interface KeyState {
  serverId: string;
  agentId: string;
  /** Daemon revision the local content descends from; null before the first contact. */
  revision: number | null;
  /** The synced content last stored on, or applied from, the daemon. */
  syncedKey: string | null;
  pushTimer: unknown;
  pushing: boolean;
  pushAgain: boolean;
  pendingRemote: ComposerDraft | null;
  idleTimer: unknown;
  /** The host accepted this chat (it has the draft, or took a write); images may upload. */
  confirmed: boolean;
  /** The host refused this chat as deleted; nothing is sent for it again in this process. */
  refused: boolean;
}

const EMPTY_DRAFT: DraftInput = { text: "", attachments: [] };

function wireOf(draft: Pick<ComposerDraft, "text" | "attachments">): WireDraft {
  return { text: draft.text, attachments: draft.attachments };
}

export class ComposerDraftSync {
  private readonly deps: ComposerDraftSyncDeps;
  private readonly hosts = new Map<string, Host>();
  private readonly keys = new Map<string, KeyState>();
  private readonly uploading = new Set<string>();
  private readonly failedUploads = new Set<string>();
  private unsubscribeLocal: (() => void) | null = null;
  private unsubscribeActivity: (() => void) | null = null;

  constructor(deps: ComposerDraftSyncDeps) {
    this.deps = deps;
  }

  async attach(serverId: string, client: ComposerDraftSyncClient): Promise<void> {
    this.detach(serverId);
    this.listen();
    const unregisterThumbnails = this.deps.registerThumbnailSource(serverId, (uploadId) =>
      client.getComposerDraftThumbnail(uploadId),
    );
    const unsubscribeUpdates = client.on("composer.draft.update", (message) => {
      if (this.hosts.get(serverId) !== host) return;
      this.receiveRemote(serverId, message.payload.draft);
    });
    const host: Host = {
      client,
      ready: false,
      unsubscribe: () => {
        unsubscribeUpdates();
        unregisterThumbnails();
      },
    };
    this.hosts.set(serverId, host);
    this.failedUploads.clear();
    try {
      await this.deps.whenLocalReady();
      const knownRevisions = this.knownRevisions(serverId);
      const drafts = await client.listComposerDrafts({ knownRevisions });
      if (this.hosts.get(serverId) !== host) return;
      host.ready = true;
      const byAgent = new Map(drafts.map((draft) => [draft.agentId, draft] as const));
      const prefix = buildDraftStoreKey({ serverId, agentId: "" });
      const agentIds = new Set(byAgent.keys());
      for (const draftKey of this.deps.listLocalKeys()) {
        if (draftKey.startsWith(prefix) && draftKey.length > prefix.length) {
          agentIds.add(draftKey.slice(prefix.length));
        }
      }
      for (const agentId of agentIds) {
        const remote = byAgent.get(agentId);
        if (remote) this.reconcile(serverId, agentId, remote);
        else if (agentId in knownRevisions) this.reconcileUnchanged(serverId, agentId);
        else this.reconcile(serverId, agentId, null);
      }
    } catch (error) {
      this.deps.warn("[ComposerDraftSync] first contact failed", error);
    }
  }

  detach(serverId: string): void {
    const host = this.hosts.get(serverId);
    if (!host) return;
    host.unsubscribe();
    this.hosts.delete(serverId);
    for (const state of this.keys.values()) {
      if (state.serverId !== serverId) continue;
      this.clearPushTimer(state);
      this.clearIdleTimer(state);
    }
  }

  /** Revisions this process holds for `serverId`'s chats; the daemon leaves those out. */
  private knownRevisions(serverId: string): Record<string, number> {
    const known: Record<string, number> = {};
    for (const state of this.keys.values()) {
      if (state.serverId === serverId && state.revision !== null && !state.refused) {
        known[state.agentId] = state.revision;
      }
    }
    return known;
  }

  private listen(): void {
    this.unsubscribeLocal ??= this.deps.subscribeLocal((draftKeys) => {
      for (const draftKey of draftKeys) this.localChanged(draftKey);
    });
    this.unsubscribeActivity ??= this.deps.activity.onMaybeIdle((draftKey) => {
      if (draftKey !== null) {
        this.tryApplyPending(draftKey);
        return;
      }
      for (const [key, state] of this.keys) {
        if (state.pendingRemote) this.tryApplyPending(key);
      }
    });
  }

  /** The ready host and agent of a synced draft key, or null for keys this module leaves alone. */
  private resolve(draftKey: string): { serverId: string; agentId: string; host: Host } | null {
    for (const [serverId, host] of this.hosts) {
      if (!host.ready) continue;
      const prefix = buildDraftStoreKey({ serverId, agentId: "" });
      if (draftKey.startsWith(prefix) && draftKey.length > prefix.length) {
        return { serverId, agentId: draftKey.slice(prefix.length), host };
      }
    }
    return null;
  }

  private state(serverId: string, agentId: string): { draftKey: string; state: KeyState } {
    const draftKey = buildDraftStoreKey({ serverId, agentId });
    let state = this.keys.get(draftKey);
    if (!state) {
      state = {
        serverId,
        agentId,
        revision: null,
        syncedKey: null,
        pushTimer: null,
        pushing: false,
        pushAgain: false,
        pendingRemote: null,
        idleTimer: null,
        confirmed: false,
        refused: false,
      };
      this.keys.set(draftKey, state);
    }
    return { draftKey, state };
  }

  private localChanged(draftKey: string): void {
    const target = this.resolve(draftKey);
    if (!target) return;
    const { state } = this.state(target.serverId, target.agentId);
    if (state.refused) return;
    this.uploadPendingImages(draftKey, state, target.host);
    this.schedulePush(draftKey, state, DRAFT_PUSH_DEBOUNCE_MS);
  }

  /** The daemon still holds the revision this process saw; only a local change goes up. */
  private reconcileUnchanged(serverId: string, agentId: string): void {
    const host = this.hosts.get(serverId);
    if (!host) return;
    const { draftKey, state } = this.state(serverId, agentId);
    if (state.refused) return;
    this.uploadPendingImages(draftKey, state, host);
    const local = this.deps.readLocal(draftKey);
    const localKey = wireDraftKey(toWireDraft(local.draft ?? EMPTY_DRAFT));
    if (localKey !== state.syncedKey) this.schedulePush(draftKey, state, 0);
    else this.tryApplyPending(draftKey);
  }

  private reconcile(serverId: string, agentId: string, remote: ComposerDraft | null): void {
    const host = this.hosts.get(serverId);
    if (!host) return;
    const { draftKey, state } = this.state(serverId, agentId);
    if (state.refused) return;
    if (remote) state.confirmed = true;
    this.uploadPendingImages(draftKey, state, host);
    const local = this.deps.readLocal(draftKey);
    const localKey = wireDraftKey(toWireDraft(local.draft ?? EMPTY_DRAFT));
    if (!remote) {
      state.revision ??= 0;
      if (local.draft && localKey !== state.syncedKey) this.schedulePush(draftKey, state, 0);
      return;
    }
    // A live update newer than this listing already arrived.
    if (state.revision !== null && remote.revision < state.revision) return;
    const remoteKey = wireDraftKey(
      toWireDraft(fromWireDraft(wireOf(remote), local.draft, serverId)),
    );
    if (remoteKey === localKey) {
      state.revision = remote.revision;
      state.syncedKey = localKey;
      return;
    }
    const localUnchanged = state.syncedKey !== null && localKey === state.syncedKey;
    if (localUnchanged || remote.updatedAt >= local.updatedAt) {
      state.revision = null;
      state.pendingRemote = remote;
      this.tryApplyPending(draftKey);
      return;
    }
    state.revision = remote.revision;
    this.schedulePush(draftKey, state, 0);
  }

  private receiveRemote(serverId: string, remote: ComposerDraft): void {
    const { draftKey, state } = this.state(serverId, remote.agentId);
    state.confirmed = true;
    state.refused = false;
    if (remote.clientId === this.deps.clientId) {
      // Our own write coming back: it is what the daemon holds, nothing to apply.
      if (!state.pushing && (state.revision === null || remote.revision > state.revision)) {
        state.revision = remote.revision;
        state.syncedKey = wireDraftKey(wireOf(remote));
      }
      return;
    }
    if (state.revision !== null && remote.revision <= state.revision) return;
    if (!state.pendingRemote || remote.revision > state.pendingRemote.revision) {
      state.pendingRemote = remote;
    }
    this.tryApplyPending(draftKey);
  }

  private tryApplyPending(draftKey: string): void {
    const state = this.keys.get(draftKey);
    const pending = state?.pendingRemote;
    if (!state || !pending) return;
    if (state.revision !== null && pending.revision <= state.revision) {
      state.pendingRemote = null;
      return;
    }
    // This device's own write goes first; the daemon's answer decides whether pending is newer.
    if (state.pushing || state.pushTimer !== null) return;
    if (this.deps.activity.isBusy(draftKey)) {
      this.clearIdleTimer(state);
      const waitMs = this.deps.activity.msUntilEditIdle(draftKey);
      if (waitMs !== null) {
        state.idleTimer = this.deps.setTimer(() => {
          state.idleTimer = null;
          this.tryApplyPending(draftKey);
        }, waitMs + 1);
      }
      return;
    }
    this.clearIdleTimer(state);
    state.pendingRemote = null;
    const local = this.deps.readLocal(draftKey).draft ?? EMPTY_DRAFT;
    const next = fromWireDraft(wireOf(pending), local, state.serverId);
    const nextKey = wireDraftKey(toWireDraft(next));
    state.revision = pending.revision;
    state.syncedKey = nextKey;
    if (nextKey === wireDraftKey(toWireDraft(local))) return;
    this.deps.applyRemote(draftKey, next);
  }

  private schedulePush(draftKey: string, state: KeyState, delayMs: number): void {
    this.clearPushTimer(state);
    state.pushTimer = this.deps.setTimer(() => {
      state.pushTimer = null;
      void this.push(draftKey, state);
    }, delayMs);
  }

  private async push(draftKey: string, state: KeyState): Promise<void> {
    const host = this.hosts.get(state.serverId);
    if (!host?.ready || state.refused) return;
    if (state.pushing) {
      state.pushAgain = true;
      return;
    }
    const wire = toWireDraft(this.deps.readLocal(draftKey).draft ?? EMPTY_DRAFT);
    const key = wireDraftKey(wire);
    if (key === state.syncedKey) {
      this.tryApplyPending(draftKey);
      return;
    }
    state.pushing = true;
    try {
      await this.store(host, state, wire, key);
      state.confirmed = true;
    } catch (error) {
      if (isAgentNotFound(error)) this.refuse(state);
      else this.deps.warn("[ComposerDraftSync] storing the draft failed", error);
    } finally {
      state.pushing = false;
    }
    if (state.refused) return;
    this.uploadPendingImages(draftKey, state, host);
    if (state.pushAgain) {
      state.pushAgain = false;
      await this.push(draftKey, state);
      return;
    }
    this.tryApplyPending(draftKey);
  }

  /** Stores the local draft on the host, or conditionally clears it there when it is empty. */
  private async store(host: Host, state: KeyState, wire: WireDraft, key: string): Promise<void> {
    if (!isEmptyWireDraft(wire)) {
      const stored = await host.client.setComposerDraft({
        agentId: state.agentId,
        text: wire.text,
        attachments: wire.attachments,
        clientId: this.deps.clientId,
        ...(state.revision !== null ? { baseRevision: state.revision } : {}),
      });
      state.revision = Math.max(state.revision ?? 0, stored.revision);
      state.syncedKey = key;
      return;
    }
    const result = await host.client.clearComposerDraft({
      agentId: state.agentId,
      clientId: this.deps.clientId,
      revision: state.revision ?? 0,
    });
    if (result.cleared) {
      state.revision = result.draft?.revision ?? state.revision;
      state.syncedKey = key;
      return;
    }
    // Text written on another device since the revision this device emptied survives.
    if (
      result.draft &&
      (!state.pendingRemote || result.draft.revision > state.pendingRemote.revision)
    ) {
      state.pendingRemote = result.draft;
    }
  }

  /** The chat was deleted on the host: stop syncing it for the rest of this process. */
  private refuse(state: KeyState): void {
    state.refused = true;
    state.pushAgain = false;
    state.pendingRemote = null;
    this.clearPushTimer(state);
    this.clearIdleTimer(state);
  }

  private uploadPendingImages(draftKey: string, state: KeyState, host: Host): void {
    if (!state.confirmed || state.refused) return;
    const draft = this.deps.readLocal(draftKey).draft;
    for (const attachment of draft?.attachments ?? []) {
      if (attachment.kind !== "image") continue;
      const { metadata } = attachment;
      if (metadata.hostUpload || metadata.storageType === "host-upload") continue;
      if (this.uploading.has(metadata.id) || this.failedUploads.has(metadata.id)) continue;
      this.uploading.add(metadata.id);
      void this.deps
        .uploadImage(host.client, metadata)
        .then((upload) => {
          this.deps.attachHostUpload(draftKey, metadata.id, upload);
          return undefined;
        })
        .catch((error: unknown) => {
          // Kept on this device only; sending uploads it then, as without sync.
          this.failedUploads.add(metadata.id);
          this.deps.warn("[ComposerDraftSync] attach-time image upload failed", error);
        })
        .finally(() => {
          this.uploading.delete(metadata.id);
        });
    }
  }

  private clearPushTimer(state: KeyState): void {
    if (state.pushTimer === null) return;
    this.deps.clearTimer(state.pushTimer);
    state.pushTimer = null;
  }

  private clearIdleTimer(state: KeyState): void {
    if (state.idleTimer === null) return;
    this.deps.clearTimer(state.idleTimer);
    state.idleTimer = null;
  }
}
