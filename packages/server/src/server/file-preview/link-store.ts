import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { preserveUnreadableFileSync } from "../atomic-file.js";
import { writePrivateFileAtomicSync } from "../private-files.js";

// Daseo delta 75: preview links are reusable capability URLs that outlive a daemon restart, so
// they are persisted. Only a hash of each token is written: the file can be read by anything
// running as the owner, and a leaked copy must not hand out working links. Entries expire on
// their own; expired ones are dropped on load and whenever a link is issued.

const PreviewLinkEntrySchema = z.object({
  tokenHash: z.string().min(1),
  absolutePath: z.string().min(1),
  fileName: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const PreviewLinkFileSchema = z.object({
  version: z.literal(1),
  links: z.array(PreviewLinkEntrySchema),
});

export type PreviewLinkEntry = z.infer<typeof PreviewLinkEntrySchema>;

export type PreviewLinkLookup =
  | { status: "found"; entry: PreviewLinkEntry }
  | { status: "expired" }
  | { status: "missing" };

export interface PreviewLinkStoreOptions {
  paseoHome: string;
  logger?: Logger;
  now?: () => number;
}

const TOKEN_BYTES = 16;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PreviewLinkStore {
  private readonly filePath: string;
  private readonly logger: Logger | null;
  private readonly now: () => number;
  private links: Map<string, PreviewLinkEntry> | null = null;

  constructor(options: PreviewLinkStoreOptions) {
    this.filePath = path.join(options.paseoHome, "preview-links.json");
    this.logger = options.logger?.child({ component: "preview-links" }) ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: { absolutePath: string; fileName: string; ttlMs: number }): {
    token: string;
    expiresAt: string;
  } {
    const links = this.load();
    this.pruneExpired(links);
    // 128 random bits, URL-safe: unguessable and short enough to read in a link.
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const now = this.now();
    const entry: PreviewLinkEntry = {
      tokenHash: hashToken(token),
      absolutePath: input.absolutePath,
      fileName: input.fileName,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
    };
    links.set(entry.tokenHash, entry);
    this.persist(links);
    return { token, expiresAt: entry.expiresAt };
  }

  lookup(token: string): PreviewLinkLookup {
    const entry = this.load().get(hashToken(token));
    if (!entry) {
      return { status: "missing" };
    }
    if (Date.parse(entry.expiresAt) <= this.now()) {
      return { status: "expired" };
    }
    return { status: "found", entry };
  }

  private pruneExpired(links: Map<string, PreviewLinkEntry>): boolean {
    const now = this.now();
    let pruned = false;
    for (const [tokenHash, entry] of links) {
      if (Date.parse(entry.expiresAt) <= now) {
        links.delete(tokenHash);
        pruned = true;
      }
    }
    return pruned;
  }

  private load(): Map<string, PreviewLinkEntry> {
    if (this.links) {
      return this.links;
    }
    const links = new Map<string, PreviewLinkEntry>();
    this.links = links;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return links;
      }
      throw error;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      // Unparseable JSON fails the schema below and is copied aside like any invalid store.
    }
    const parsed = PreviewLinkFileSchema.safeParse(data);
    if (!parsed.success) {
      const backupPath = preserveUnreadableFileSync(this.filePath);
      this.logger?.warn(
        { issues: parsed.error.issues, filePath: this.filePath, backupPath },
        "Ignoring invalid preview link store",
      );
      return links;
    }
    for (const entry of parsed.data.links) {
      links.set(entry.tokenHash, entry);
    }
    if (this.pruneExpired(links)) {
      this.persist(links);
    }
    return links;
  }

  private persist(links: Map<string, PreviewLinkEntry>): void {
    writePrivateFileAtomicSync(
      this.filePath,
      `${JSON.stringify({ version: 1, links: [...links.values()] }, null, 2)}\n`,
    );
  }
}
