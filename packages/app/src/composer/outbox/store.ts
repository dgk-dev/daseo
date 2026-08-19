import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import type { ComposerAttachment } from "@/attachments/types";

const OUTBOX_STORAGE_KEY = "@paseo:composer-outbox";
const OUTBOX_VERSION = 1;
const MAX_OUTBOX_RECORDS = 1_000;

export class ComposerOutboxCorruptionError extends Error {
  constructor() {
    super("Composer recovery data is unreadable and was preserved for manual recovery");
    this.name = "ComposerOutboxCorruptionError";
  }
}

const OutboxRecordSchema = z.object({
  version: z.literal(OUTBOX_VERSION),
  id: z.string().min(1),
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  text: z.string(),
  attachments: z.array(z.unknown()),
  intent: z.enum(["queued", "dispatch"]),
  status: z.enum(["queued", "pending", "delivery_unknown", "in_flight", "rejected"]),
  steering: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
});

const OutboxFileSchema = z.object({
  version: z.literal(OUTBOX_VERSION),
  records: z.array(OutboxRecordSchema),
});

export interface ComposerOutboxRecord {
  version: 1;
  id: string;
  serverId: string;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  intent: "queued" | "dispatch";
  status: "queued" | "pending" | "delivery_unknown" | "in_flight" | "rejected";
  steering?: boolean;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
  lastError?: string | null;
}

export interface ComposerOutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function recordKey(record: Pick<ComposerOutboxRecord, "serverId" | "id">): string {
  return `${record.serverId}\u0000${record.id}`;
}

function normalizeRecord(value: z.infer<typeof OutboxRecordSchema>): ComposerOutboxRecord {
  return {
    ...value,
    attachments: value.attachments as ComposerAttachment[],
  };
}

function equalPayload(
  existing: ComposerOutboxRecord,
  input: Pick<ComposerOutboxRecord, "serverId" | "agentId" | "text" | "attachments">,
): boolean {
  return (
    existing.serverId === input.serverId &&
    existing.agentId === input.agentId &&
    existing.text === input.text &&
    JSON.stringify(existing.attachments) === JSON.stringify(input.attachments)
  );
}

function createDefaultOutboxStorage(): ComposerOutboxStorage {
  if (process.env.NODE_ENV !== "test") return AsyncStorage;
  const values = new Map<string, string>();
  return {
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

export class ComposerOutboxStore {
  private readonly storage: ComposerOutboxStorage;
  private readonly records = new Map<string, ComposerOutboxRecord>();
  private readonly listeners = new Set<() => void>();
  private hydration: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private corruptionError: ComposerOutboxCorruptionError | null = null;
  private unreadableRaw: string | null = null;

  constructor(storage: ComposerOutboxStorage = createDefaultOutboxStorage()) {
    this.storage = storage;
  }

  async hydrate(): Promise<void> {
    if (!this.hydration) this.hydration = this.load();
    await this.hydration;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(filter?: {
    serverId?: string;
    agentId?: string;
    intent?: ComposerOutboxRecord["intent"];
  }): Promise<ComposerOutboxRecord[]> {
    await this.hydrate();
    const matching = [...this.records.values()]
      .filter(
        (record) =>
          (!filter?.serverId || record.serverId === filter.serverId) &&
          (!filter?.agentId || record.agentId === filter.agentId) &&
          (!filter?.intent || record.intent === filter.intent),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    const snapshots: ComposerOutboxRecord[] = [];
    for (const record of matching) {
      snapshots.push(Object.assign({}, record, { attachments: [...record.attachments] }));
    }
    return snapshots;
  }

  async enqueue(input: {
    id: string;
    serverId: string;
    agentId: string;
    text: string;
    attachments: ComposerAttachment[];
    intent: ComposerOutboxRecord["intent"];
    steering?: boolean;
    now?: number;
  }): Promise<ComposerOutboxRecord> {
    return await this.mutate(async (next) => {
      const key = recordKey(input);
      const existing = next.get(key);
      if (existing) {
        if (!equalPayload(existing, input)) {
          throw new Error(`Composer outbox id already belongs to another payload: ${input.id}`);
        }
        return existing;
      }
      if (next.size >= MAX_OUTBOX_RECORDS) {
        throw new Error(
          `Composer outbox is full (${MAX_OUTBOX_RECORDS} unresolved messages); resolve one before sending another`,
        );
      }
      const now = input.now ?? Date.now();
      const record: ComposerOutboxRecord = {
        version: 1,
        id: input.id,
        serverId: input.serverId,
        agentId: input.agentId,
        text: input.text,
        attachments: [...input.attachments],
        intent: input.intent,
        status: input.intent === "queued" ? "queued" : "pending",
        ...(input.steering ? { steering: true } : {}),
        createdAt: now,
        updatedAt: now,
        attemptCount: 0,
        lastError: null,
      };
      next.set(key, record);
      return record;
    });
  }

  async mark(input: {
    serverId: string;
    id: string;
    intent?: ComposerOutboxRecord["intent"];
    status: ComposerOutboxRecord["status"];
    lastError?: string | null;
    incrementAttempt?: boolean;
    now?: number;
  }): Promise<ComposerOutboxRecord | null> {
    return await this.mutate(async (next) => {
      const key = recordKey(input);
      const existing = next.get(key);
      if (!existing) return null;
      const record: ComposerOutboxRecord = {
        ...existing,
        ...(input.intent ? { intent: input.intent } : {}),
        status: input.status,
        updatedAt: input.now ?? Date.now(),
        attemptCount: existing.attemptCount + (input.incrementAttempt ? 1 : 0),
        lastError: input.lastError ?? null,
      };
      next.set(key, record);
      return record;
    });
  }

  async remove(serverId: string, id: string): Promise<boolean> {
    return await this.mutate(async (next) => next.delete(recordKey({ serverId, id })));
  }

  async rekeyServerId(oldServerId: string, newServerId: string): Promise<void> {
    if (oldServerId === newServerId) return;
    await this.mutate(async (next) => {
      for (const [key, record] of Array.from(next.entries())) {
        if (record.serverId !== oldServerId) continue;
        next.delete(key);
        const updated = { ...record, serverId: newServerId, updatedAt: Date.now() };
        const nextKey = recordKey(updated);
        const collision = next.get(nextKey);
        if (collision && !equalPayload(collision, updated)) {
          throw new Error(`Cannot rekey composer outbox record ${record.id}`);
        }
        next.set(nextKey, collision ?? updated);
      }
    });
  }

  async collectAttachmentIds(): Promise<Set<string>> {
    await this.hydrate();
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      for (const attachment of record.attachments) {
        if (attachment.kind === "image") ids.add(attachment.metadata.id);
        if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
          ids.add(attachment.attachment.screenshot.id);
        }
      }
    }
    if (this.unreadableRaw) {
      for (const match of this.unreadableRaw.matchAll(/"id"\s*:\s*"([^"]+)"/gu)) {
        const id = match[1]?.trim();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  async flush(): Promise<void> {
    await this.hydrate();
    await this.mutationTail;
  }

  private async load(): Promise<void> {
    const raw = await this.storage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      this.unreadableRaw = raw;
      this.corruptionError = new ComposerOutboxCorruptionError();
      return;
    }
    const parsed = OutboxFileSchema.safeParse(decoded);
    if (!parsed.success) {
      this.unreadableRaw = raw;
      this.corruptionError = new ComposerOutboxCorruptionError();
      return;
    }
    for (const persisted of parsed.data.records) {
      const record = normalizeRecord(persisted);
      this.records.set(recordKey(record), record);
    }
  }

  private async mutate<T>(
    operation: (next: Map<string, ComposerOutboxRecord>) => Promise<T>,
  ): Promise<T> {
    await this.hydrate();
    const previous = this.mutationTail;
    const run = (async () => {
      await previous;
      if (this.corruptionError) throw this.corruptionError;
      const next = new Map(this.records);
      const result = await operation(next);
      const records = [...next.values()].sort((left, right) => left.createdAt - right.createdAt);
      if (records.length === 0) {
        await this.storage.removeItem(OUTBOX_STORAGE_KEY);
      } else {
        await this.storage.setItem(
          OUTBOX_STORAGE_KEY,
          JSON.stringify({ version: OUTBOX_VERSION, records }),
        );
      }
      this.records.clear();
      for (const record of records) this.records.set(recordKey(record), record);
      for (const listener of this.listeners) listener();
      return result;
    })();
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

export const composerOutboxStore = new ComposerOutboxStore();
