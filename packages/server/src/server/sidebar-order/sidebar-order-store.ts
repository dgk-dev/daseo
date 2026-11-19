import { promises as fs } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import { SidebarOrderSchema, type SidebarOrder } from "@getpaseo/protocol/messages";
import { preserveUnreadableFile, writeJsonFileAtomic } from "../atomic-file.js";

/**
 * Daseo delta 133: the one sidebar order every connected device shows, at
 * `$PASEO_HOME/sidebar-order.json`. The keys are the app's sidebar keys; the daemon stores the
 * whole state as the last client sent it (last write wins) and tells every listener which caller
 * wrote it, so the writer is not pushed its own change.
 */
const SidebarOrderFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  order: SidebarOrderSchema,
});

export type SidebarOrderListener = (order: SidebarOrder, origin: object | null) => void;

export class SidebarOrderStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private readonly now: () => Date;
  private loaded: Promise<SidebarOrder | null> | null = null;
  private current: SidebarOrder | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<SidebarOrderListener>();

  constructor(options: { filePath: string; logger: pino.Logger; now?: () => Date }) {
    this.filePath = options.filePath;
    this.logger = options.logger.child({ module: "sidebar-order-store" });
    this.now = options.now ?? (() => new Date());
  }

  /** The stored order, or null when no client has stored one yet. */
  async get(): Promise<SidebarOrder | null> {
    await this.load();
    await this.writes.catch(() => undefined);
    return this.current;
  }

  /** Stores the whole order and notifies every listener with the writer as origin. */
  set(order: SidebarOrder, origin: object | null): Promise<SidebarOrder> {
    const run = this.writes.catch(() => undefined).then(() => this.write(order, origin));
    this.writes = run;
    return run;
  }

  onChange(listener: SidebarOrderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async write(order: SidebarOrder, origin: object | null): Promise<SidebarOrder> {
    await this.load();
    const next = SidebarOrderSchema.parse(order);
    await writeJsonFileAtomic(this.filePath, {
      version: 1,
      updatedAt: this.now().toISOString(),
      order: next,
    });
    this.current = next;
    this.notify(next, origin);
    return next;
  }

  private notify(order: SidebarOrder, origin: object | null): void {
    for (const listener of this.listeners) {
      try {
        listener(order, origin);
      } catch (error) {
        this.logger.warn({ err: error }, "Sidebar order listener failed");
      }
    }
  }

  private load(): Promise<SidebarOrder | null> {
    this.loaded ??= this.readFromDisk().then((order) => {
      this.current = order;
      return order;
    });
    return this.loaded;
  }

  private async readFromDisk(): Promise<SidebarOrder | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.warn({ err: error, filePath: this.filePath }, "Sidebar order unreadable");
      return null;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = SidebarOrderFileSchema.safeParse(json);
    if (parsed.success) return parsed.data.order;
    const backupPath = await preserveUnreadableFile(this.filePath);
    this.logger.warn(
      { filePath: this.filePath, backupPath },
      "Sidebar order file invalid; starting without a stored order",
    );
    return null;
  }
}
