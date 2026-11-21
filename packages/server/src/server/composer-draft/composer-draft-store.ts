import { promises as fs } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import {
  ComposerDraftSchema,
  type ComposerDraft,
  type ComposerDraftAttachment,
} from "@getpaseo/protocol/messages";
import { preserveUnreadableFile, writeFileAtomic } from "../atomic-file.js";
import { markUploadsDraftReferenced, refreshDraftUploadAge } from "../file-upload/index.js";

/**
 * Daseo delta 139: the unsent composer draft of every existing agent chat, at
 * `$PASEO_HOME/composer-drafts.json`, so a draft follows the owner between devices. Kept apart
 * from the agent records: drafts are written several times a second while typing and must not
 * queue behind agent record writes.
 *
 * Last writer wins. A cleared draft stays as an empty record with its revision, so a stale clear
 * (a send of older text) cannot erase text written since; empty records older than 30 days are
 * dropped on load. Uploads a stored draft references are pinned against the abandoned-upload sweep
 * and marked so sending does not remove them; an upload a write or clear drops from the draft gets
 * its age restarted, so a message queued from the draft still finds it (file-upload/index.ts).
 * Thumbnail bytes are not part of a draft: they sit next to their upload.
 */
const ComposerDraftFileSchema = z.object({
  version: z.literal(1),
  drafts: z.record(z.string(), ComposerDraftSchema),
});

const CLEARED_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ComposerDraftListener = (draft: ComposerDraft, origin: object | null) => void;

export interface ComposerDraftWrite {
  agentId: string;
  text: string;
  attachments: readonly ComposerDraftAttachment[];
  clientId: string;
}

export interface ComposerDraftClear {
  agentId: string;
  clientId: string;
  revision: number;
}

export interface ComposerDraftClearResult {
  draft: ComposerDraft | null;
  cleared: boolean;
}

export function isEmptyComposerDraft(draft: Pick<ComposerDraft, "text" | "attachments">): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

function uploadIdsOf(draft: Pick<ComposerDraft, "attachments">): string[] {
  return draft.attachments.flatMap((attachment) =>
    attachment.uploadId ? [attachment.uploadId] : [],
  );
}

export class ComposerDraftStore {
  private readonly filePath: string;
  private readonly paseoHome: string;
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private loaded: Promise<void> | null = null;
  private drafts = new Map<string, ComposerDraft>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<ComposerDraftListener>();

  constructor(options: {
    filePath: string;
    paseoHome: string;
    logger: pino.Logger;
    now?: () => number;
  }) {
    this.filePath = options.filePath;
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "composer-draft-store" });
    this.now = options.now ?? (() => Date.now());
  }

  /** Stored drafts, cleared ones included (their revision matters to reconciling clients). */
  async list(agentIds?: readonly string[]): Promise<ComposerDraft[]> {
    await this.settled();
    if (!agentIds) return Array.from(this.drafts.values());
    return agentIds.flatMap((agentId) => {
      const draft = this.drafts.get(agentId);
      return draft ? [draft] : [];
    });
  }

  async get(agentId: string): Promise<ComposerDraft | null> {
    await this.settled();
    return this.drafts.get(agentId) ?? null;
  }

  /** Stores the draft (last writer wins) and notifies every listener. */
  set(write: ComposerDraftWrite, origin: object | null): Promise<ComposerDraft> {
    return this.enqueue(async () => {
      const previous = this.drafts.get(write.agentId);
      const draft: ComposerDraft = {
        agentId: write.agentId,
        text: write.text,
        attachments: [...write.attachments],
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: this.now(),
        clientId: write.clientId,
      };
      await this.commit(draft, origin);
      await markUploadsDraftReferenced({
        paseoHome: this.paseoHome,
        uploadIds: uploadIdsOf(draft),
      });
      await this.refreshDropped(previous, draft);
      return draft;
    });
  }

  /**
   * Clears the draft only while its revision is still the one the client cleared or sent; a draft
   * written since survives and is returned.
   */
  clear(request: ComposerDraftClear, origin: object | null): Promise<ComposerDraftClearResult> {
    return this.enqueue(async () => {
      const current = this.drafts.get(request.agentId);
      if (!current) return { draft: null, cleared: true };
      if (current.revision > request.revision) return { draft: current, cleared: false };
      if (isEmptyComposerDraft(current)) return { draft: current, cleared: true };
      const cleared: ComposerDraft = {
        agentId: request.agentId,
        text: "",
        attachments: [],
        revision: current.revision + 1,
        updatedAt: this.now(),
        clientId: request.clientId,
      };
      await this.commit(cleared, origin);
      await this.refreshDropped(current, cleared);
      return { draft: cleared, cleared: true };
    });
  }

  /** The agent was deleted: its draft goes, and its uploads are no longer pinned. */
  remove(agentId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.drafts.has(agentId)) return;
      this.drafts.delete(agentId);
      await this.persist();
    });
  }

  private async refreshDropped(
    previous: ComposerDraft | undefined,
    next: ComposerDraft,
  ): Promise<void> {
    if (!previous) return;
    const kept = new Set(uploadIdsOf(next));
    const dropped = uploadIdsOf(previous).filter((uploadId) => !kept.has(uploadId));
    if (dropped.length > 0) {
      await refreshDraftUploadAge({ paseoHome: this.paseoHome, uploadIds: dropped });
    }
  }

  /** Upload ids referenced by a stored draft; the abandoned-upload sweep keeps these. */
  async pinnedUploadIds(): Promise<ReadonlySet<string>> {
    await this.settled();
    const pinned = new Set<string>();
    for (const draft of this.drafts.values()) {
      for (const uploadId of uploadIdsOf(draft)) pinned.add(uploadId);
    }
    return pinned;
  }

  onChange(listener: ComposerDraftListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async settled(): Promise<void> {
    await this.load();
    await this.writes.catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        return await operation();
      });
    this.writes = run;
    return run;
  }

  private async commit(draft: ComposerDraft, origin: object | null): Promise<void> {
    const previous = this.drafts.get(draft.agentId);
    this.drafts.set(draft.agentId, draft);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.drafts.set(draft.agentId, previous);
      else this.drafts.delete(draft.agentId);
      throw error;
    }
    this.notify(draft, origin);
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.filePath,
      JSON.stringify({ version: 1, drafts: Object.fromEntries(this.drafts) }),
    );
  }

  private notify(draft: ComposerDraft, origin: object | null): void {
    for (const listener of this.listeners) {
      try {
        listener(draft, origin);
      } catch (error) {
        this.logger.warn({ err: error }, "Composer draft listener failed");
      }
    }
  }

  private load(): Promise<void> {
    this.loaded ??= this.readFromDisk().then((drafts) => {
      this.drafts = drafts;
      return undefined;
    });
    return this.loaded;
  }

  private async readFromDisk(): Promise<Map<string, ComposerDraft>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      this.logger.warn({ err: error, filePath: this.filePath }, "Composer drafts unreadable");
      return new Map();
    }
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = ComposerDraftFileSchema.safeParse(json);
    if (!parsed.success) {
      const backupPath = await preserveUnreadableFile(this.filePath);
      this.logger.warn(
        { filePath: this.filePath, backupPath },
        "Composer drafts file invalid; starting without stored drafts",
      );
      return new Map();
    }
    const cutoff = this.now() - CLEARED_DRAFT_RETENTION_MS;
    const drafts = new Map<string, ComposerDraft>();
    for (const draft of Object.values(parsed.data.drafts)) {
      if (isEmptyComposerDraft(draft) && draft.updatedAt < cutoff) continue;
      drafts.set(draft.agentId, draft);
    }
    return drafts;
  }
}
