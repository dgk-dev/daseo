import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const STORE_VERSION = 1;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ROW_FILE_PATTERN = /^(\d{16})\.json$/;

const PersistedTimelineStateSchema = z.object({
  version: z.literal(STORE_VERSION),
  epoch: z.string().min(1),
  nextSeq: z.number().int().positive(),
});

const PersistedTimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

interface CachedTimelineState {
  epoch: string;
  nextSeq: number;
  rows: AgentTimelineRow[];
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: { ...row.item } } as AgentTimelineRow;
}

function assertSafeAgentId(agentId: string): void {
  if (!SAFE_AGENT_ID.test(agentId)) {
    throw new Error(`Unsafe agent timeline id '${agentId}'`);
  }
}

function rowFileName(seq: number): string {
  return `${String(seq).padStart(16, "0")}.json`;
}

export class FileBackedAgentTimelineStore implements AgentTimelineStore {
  private readonly cache = new Map<string, CachedTimelineState>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string) {
    ensurePrivateDirectory(baseDir);
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    let result: AgentTimelineRow | null = null;
    await this.queueMutation(agentId, async (state) => {
      const row: AgentTimelineRow = {
        seq: state.nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
      };
      state.nextSeq += 1;
      state.rows.push(row);
      await this.writeRow(agentId, row);
      await this.writeState(agentId, state);
      result = cloneRow(row);
    });
    if (!result) throw new Error(`Failed to append timeline row for '${agentId}'`);
    return result;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const state = await this.load(agentId);
    const memory = new InMemoryAgentTimelineStore();
    memory.initialize(agentId, {
      rows: state.rows,
      epoch: state.epoch,
      nextSeq: state.nextSeq,
    });
    return memory.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const state = await this.load(agentId);
    return state.rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const state = await this.load(agentId);
    return state.rows.map(cloneRow);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const state = await this.load(agentId);
    return state.rows.at(-1)?.item ?? null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const state = await this.load(agentId);
    const chunks: string[] = [];
    for (let index = state.rows.length - 1; index >= 0; index -= 1) {
      const item = state.rows[index]?.item;
      if (!item) continue;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    assertSafeAgentId(agentId);
    const previous = this.mutationTails.get(agentId) ?? Promise.resolve();
    await previous.catch(() => undefined);
    this.cache.delete(agentId);
    await fs.rm(this.agentDirectory(agentId), { recursive: true, force: true });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.queueMutation(agentId, async (state) => {
      const bySeq = new Map(state.rows.map((row) => [row.seq, row]));
      for (const candidate of [...rows].sort((left, right) => left.seq - right.seq)) {
        const row = PersistedTimelineRowSchema.parse(candidate);
        bySeq.set(row.seq, cloneRow(row));
        await this.writeRow(agentId, row);
      }
      state.rows = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
      state.nextSeq = Math.max(state.nextSeq, (state.rows.at(-1)?.seq ?? 0) + 1);
      await this.writeState(agentId, state);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.queueMutation(agentId, async (state) => {
      const parsed = PersistedTimelineRowSchema.parse(row);
      const index = state.rows.findIndex((candidate) => candidate.seq === parsed.seq);
      if (index < 0) {
        throw new Error(`Cannot update missing timeline row ${parsed.seq} for '${agentId}'`);
      }
      state.rows[index] = cloneRow(parsed);
      await this.writeRow(agentId, parsed);
    });
  }

  private async queueMutation(
    agentId: string,
    mutation: (state: CachedTimelineState) => Promise<void>,
  ): Promise<void> {
    assertSafeAgentId(agentId);
    const previous = this.mutationTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const state = await this.load(agentId);
        await mutation(state);
        return undefined;
      });
    const tracked = next.finally(() => {
      if (this.mutationTails.get(agentId) === tracked) {
        this.mutationTails.delete(agentId);
      }
    });
    this.mutationTails.set(agentId, tracked);
    await tracked;
  }

  private async load(agentId: string): Promise<CachedTimelineState> {
    assertSafeAgentId(agentId);
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const directory = this.agentDirectory(agentId);
    ensurePrivateDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const rows: AgentTimelineRow[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !ROW_FILE_PATTERN.test(entry.name)) continue;
      const raw = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
      const row = PersistedTimelineRowSchema.parse(raw);
      if (entry.name !== rowFileName(row.seq)) {
        throw new Error(`Timeline row filename does not match seq for '${agentId}'`);
      }
      rows.push(row);
    }
    rows.sort((left, right) => left.seq - right.seq);
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1]?.seq === rows[index]?.seq) {
        throw new Error(`Duplicate timeline seq ${rows[index]?.seq} for '${agentId}'`);
      }
    }

    const persisted = await this.readState(agentId);
    const minimumNextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    const state: CachedTimelineState = {
      epoch: persisted?.epoch ?? randomUUID(),
      nextSeq: Math.max(persisted?.nextSeq ?? 1, minimumNextSeq),
      rows,
    };
    this.cache.set(agentId, state);
    if (!persisted || persisted.nextSeq !== state.nextSeq) {
      await this.writeState(agentId, state);
    }
    return state;
  }

  private async readState(
    agentId: string,
  ): Promise<z.infer<typeof PersistedTimelineStateSchema> | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath(agentId), "utf8"));
      return PersistedTimelineStateSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeState(agentId: string, state: CachedTimelineState): Promise<void> {
    const statePath = this.statePath(agentId);
    await writeJsonFileAtomic(statePath, {
      version: STORE_VERSION,
      epoch: state.epoch,
      nextSeq: state.nextSeq,
    });
    ensurePrivateFile(statePath);
  }

  private async writeRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    const rowPath = path.join(this.agentDirectory(agentId), rowFileName(row.seq));
    await writeJsonFileAtomic(rowPath, row);
    ensurePrivateFile(rowPath);
  }

  private agentDirectory(agentId: string): string {
    return path.join(this.baseDir, agentId);
  }

  private statePath(agentId: string): string {
    return path.join(this.agentDirectory(agentId), "state.json");
  }
}
