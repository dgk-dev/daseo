import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RECEIPTS = 4_096;
const INTERRUPTED_RECEIPT_ERROR = "Daemon restarted before command confirmation";

const AgentCommandReceiptSchema = z.object({
  commandId: z.string().min(1),
  agentId: z.string().min(1),
  payloadHash: z.string().min(1),
  status: z.enum(["in_flight", "accepted", "rejected"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().nullable().optional(),
});

const AgentCommandReceiptFileSchema = z.object({
  version: z.literal(1),
  receipts: z.array(AgentCommandReceiptSchema),
});

export type AgentCommandReceipt = z.infer<typeof AgentCommandReceiptSchema>;

export type AgentCommandAdmission =
  | { kind: "new"; receipt: AgentCommandReceipt }
  | { kind: "existing"; receipt: AgentCommandReceipt }
  | { kind: "conflict"; receipt: AgentCommandReceipt };

export interface AgentCommandReceiptResolution {
  status: "missing" | "in_flight" | "accepted" | "rejected" | "retry_ready";
  receipt: AgentCommandReceipt | null;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function hashAgentCommandPayload(input: {
  agentId: string;
  text: string;
  images?: readonly { data: string; mimeType: string }[];
  attachments?: readonly unknown[];
}): string {
  const hash = createHash("sha256");
  hash.update(input.agentId);
  hash.update("\0");
  hash.update(input.text);
  for (const image of input.images ?? []) {
    hash.update("\0image\0");
    hash.update(image.mimeType);
    hash.update("\0");
    hash.update(image.data);
  }
  hash.update("\0attachments\0");
  hash.update(stableJson(input.attachments ?? []));
  return `sha256:${hash.digest("hex")}`;
}

export class AgentCommandReceiptStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly receipts = new Map<string, AgentCommandReceipt>();
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(paseoHome: string, logger: Logger) {
    this.filePath = join(paseoHome, "agent-command-receipts.json");
    this.logger = logger.child({ component: "agent-command-receipts" });
  }

  async get(commandId: string): Promise<AgentCommandReceipt | null> {
    await this.load();
    return this.receipts.get(commandId) ?? null;
  }

  async admit(input: {
    commandId: string;
    agentId: string;
    payloadHash: string;
    now?: Date;
  }): Promise<AgentCommandAdmission> {
    return await this.mutate(async () => {
      const existing = this.receipts.get(input.commandId);
      if (existing) {
        const sameCommand =
          existing.agentId === input.agentId && existing.payloadHash === input.payloadHash;
        return {
          kind: sameCommand ? "existing" : "conflict",
          receipt: existing,
        } as AgentCommandAdmission;
      }
      const now = (input.now ?? new Date()).toISOString();
      const receipt: AgentCommandReceipt = {
        commandId: input.commandId,
        agentId: input.agentId,
        payloadHash: input.payloadHash,
        status: "in_flight",
        createdAt: now,
        updatedAt: now,
        error: null,
      };
      this.receipts.set(receipt.commandId, receipt);
      await this.persist(input.now);
      return { kind: "new", receipt } as AgentCommandAdmission;
    });
  }

  async settle(input: {
    commandId: string;
    status: "accepted" | "rejected";
    error?: string | null;
    now?: Date;
  }): Promise<AgentCommandReceipt | null> {
    return await this.mutate(async () => {
      const existing = this.receipts.get(input.commandId);
      if (!existing) return null;
      const receipt: AgentCommandReceipt = {
        ...existing,
        status: input.status,
        updatedAt: (input.now ?? new Date()).toISOString(),
        error: input.error ?? null,
      };
      this.receipts.set(receipt.commandId, receipt);
      await this.persist(input.now);
      return receipt;
    });
  }

  async resolve(input: {
    commandId: string;
    action: "retry" | "discard";
    now?: Date;
  }): Promise<AgentCommandReceiptResolution> {
    return await this.mutate(async () => {
      const existing = this.receipts.get(input.commandId) ?? null;
      if (input.action === "retry") {
        if (existing?.status === "accepted") {
          return { status: "accepted", receipt: existing };
        }
        if (existing) this.receipts.delete(input.commandId);
        try {
          if (existing) await this.persist(input.now);
        } catch (error) {
          if (existing) this.receipts.set(input.commandId, existing);
          throw error;
        }
        return { status: "retry_ready", receipt: existing };
      }

      if (!existing) return { status: "missing", receipt: null };
      if (existing.status === "accepted" || existing.status === "rejected") {
        return { status: existing.status, receipt: existing };
      }
      const receipt: AgentCommandReceipt = {
        ...existing,
        status: "rejected",
        updatedAt: (input.now ?? new Date()).toISOString(),
        error: "Discarded by operator",
      };
      this.receipts.set(receipt.commandId, receipt);
      try {
        await this.persist(input.now);
      } catch (error) {
        this.receipts.set(existing.commandId, existing);
        throw error;
      }
      return { status: "rejected", receipt };
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.load();
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = AgentCommandReceiptFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, "Ignoring invalid command receipt file");
      return;
    }
    const now = new Date();
    let recoveredInterruptedReceipt = false;
    for (const receipt of parsed.data.receipts) {
      if (receipt.status !== "in_flight") {
        this.receipts.set(receipt.commandId, receipt);
        continue;
      }
      recoveredInterruptedReceipt = true;
      this.receipts.set(receipt.commandId, {
        ...receipt,
        status: "rejected",
        updatedAt: now.toISOString(),
        error: INTERRUPTED_RECEIPT_ERROR,
      });
    }
    this.prune(now);
    if (recoveredInterruptedReceipt) {
      await this.persist(now);
    }
  }

  private prune(now: Date): void {
    const cutoff = now.getTime() - RECEIPT_TTL_MS;
    for (const [commandId, receipt] of this.receipts) {
      if (receipt.status !== "in_flight" && Date.parse(receipt.updatedAt) < cutoff) {
        this.receipts.delete(commandId);
      }
    }
    if (this.receipts.size <= MAX_RECEIPTS) return;
    const removable = [...this.receipts.values()]
      .filter((receipt) => receipt.status !== "in_flight")
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const receipt of removable) {
      if (this.receipts.size <= MAX_RECEIPTS) break;
      this.receipts.delete(receipt.commandId);
    }
  }

  private async persist(now = new Date()): Promise<void> {
    this.prune(now);
    await writeJsonFileAtomic(this.filePath, {
      version: 1,
      receipts: [...this.receipts.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    });
  }
}

const stores = new Map<string, AgentCommandReceiptStore>();

export function getAgentCommandReceiptStore(
  paseoHome: string,
  logger: Logger,
): AgentCommandReceiptStore {
  const existing = stores.get(paseoHome);
  if (existing) return existing;
  const store = new AgentCommandReceiptStore(paseoHome, logger);
  stores.set(paseoHome, store);
  return store;
}
