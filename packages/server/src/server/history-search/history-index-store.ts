import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  MAX_INDEXED_MESSAGE_CHARS,
  type HistoryMessage,
  type HistoryMessageRole,
} from "./history-text.js";

/**
 * The derived History search index: one SQLite file under `$PASEO_HOME/search`.
 * It is a cache of what the timelines and provider session files already hold,
 * so a missing file, a schema change, or an unreadable file means "rebuild",
 * never "migrate". Each method is one statement or one transaction (see
 * docs/data-model.md, "Store Surface Rules").
 *
 * Messages carry an FTS5 trigram index. Trigram matches any 3+ character
 * substring, which is what Korean needs (particles attach to words, so a
 * word-boundary tokenizer misses "규칙" inside "규칙을"), but it cannot match
 * a 1–2 character token; those fall back to a LIKE scan, which measured at a
 * few milliseconds over the whole corpus.
 */

const SCHEMA_VERSION = "1";

// @types/node@20 predates the node:sqlite typings; declare the slice used here.
interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteValue[]): Record<string, unknown> | undefined;
  all(...params: SqliteValue[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}
type SqliteValue = string | number | bigint | null | Uint8Array;

/** `none`: a root session with no readable text, kept so progress counts it. */
export type HistorySessionSource = "timeline" | "pi-file" | "none";

export interface HistorySessionRecord {
  agentId: string;
  source: HistorySessionSource;
  /** Timeline epoch, or `<mtimeMs>:<size>` of a provider session file. */
  sourceMark: string;
  /** Highest timeline row read; 0 for provider session files. */
  indexedSeq: number;
  lastAnchorSeq: number | null;
  /** Last row of the trailing assistant run, which the next rows may continue. */
  tailAssistantSeq: number | null;
  textChars: number;
  messageCount: number;
  /** `textChars` when the session was last embedded, with the model used. */
  embeddedChars: number | null;
  embeddedModel: string | null;
}

export interface StoredHistoryMessage {
  id: number;
  agentId: string;
  ordinal: number;
  role: HistoryMessageRole;
  text: string;
  seq: number | null;
  anchorSeq: number | null;
}

export interface StoredEmbeddingChunk {
  agentId: string;
  window: number;
  messageId: number;
  textHash: string;
  vector: Float32Array;
}

export interface HistoryChunkInput {
  window: number;
  messageId: number;
  textHash: string;
  vector: Float32Array;
}

const SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
  agent_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_mark TEXT NOT NULL,
  indexed_seq INTEGER NOT NULL,
  last_anchor_seq INTEGER,
  tail_assistant_seq INTEGER,
  text_chars INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  embedded_chars INTEGER,
  embedded_model TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  seq INTEGER,
  anchor_seq INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX messages_by_agent ON messages(agent_id, ordinal);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER messages_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_after_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE chunks (
  agent_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (agent_id, window_index)
);
`;

/** Shortest token the trigram index can answer; shorter ones use LIKE. */
const TRIGRAM_MIN_CHARS = 3;

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : (value as number);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToVector(blob: unknown): Float32Array {
  const bytes = blob as Uint8Array;
  // Copy: the driver may reuse the buffer, and Float32Array needs 4-byte alignment.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export class HistoryIndexUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `History search index is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "HistoryIndexUnavailableError";
  }
}

export class HistoryIndexStore {
  private constructor(private readonly db: SqliteDatabase) {}

  /**
   * Opens the index, recreating it when the file is missing, unreadable, or
   * from another schema version. Throws HistoryIndexUnavailableError when the
   * runtime has no node:sqlite with FTS5 (Node before 22.5).
   */
  static async open(filePath: string): Promise<HistoryIndexStore> {
    // Held in a variable so TypeScript skips module resolution (see above).
    const sqliteSpecifier: string = "node:sqlite";
    let sqlite: NodeSqliteModule;
    try {
      sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    } catch (error) {
      throw new HistoryIndexUnavailableError(error);
    }
    if (filePath !== ":memory:") {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const existing = HistoryIndexStore.tryOpenExisting(sqlite, filePath);
    if (existing) return existing;
    if (filePath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${filePath}${suffix}`, { force: true });
      }
    }
    try {
      const db = new sqlite.DatabaseSync(filePath);
      HistoryIndexStore.configure(db);
      db.exec("BEGIN");
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
      db.exec("COMMIT");
      return new HistoryIndexStore(db);
    } catch (error) {
      throw new HistoryIndexUnavailableError(error);
    }
  }

  private static tryOpenExisting(
    sqlite: NodeSqliteModule,
    filePath: string,
  ): HistoryIndexStore | null {
    if (filePath === ":memory:") return null;
    let db: SqliteDatabase | null = null;
    try {
      db = new sqlite.DatabaseSync(filePath);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      if (row?.value !== SCHEMA_VERSION) {
        db.close();
        return null;
      }
      HistoryIndexStore.configure(db);
      return new HistoryIndexStore(db);
    } catch {
      db?.close();
      return null;
    }
  }

  private static configure(db: SqliteDatabase): void {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }

  close(): void {
    this.db.close();
  }

  listSessions(): HistorySessionRecord[] {
    return this.db.prepare("SELECT * FROM sessions").all().map(toSessionRecord);
  }

  getSession(agentId: string): HistorySessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE agent_id = ?").get(agentId);
    return row ? toSessionRecord(row) : null;
  }

  /** Replaces everything indexed for a session (a first read or a reset source). */
  replaceSession(input: {
    session: Omit<
      HistorySessionRecord,
      "textChars" | "messageCount" | "embeddedChars" | "embeddedModel"
    >;
    messages: readonly HistoryMessage[];
  }): void {
    this.transaction(() => {
      this.deleteSessionRows(input.session.agentId);
      const { textChars, messageCount } = this.insertMessages(
        input.session.agentId,
        input.messages,
        { ordinal: 0, textChars: 0 },
      );
      this.db
        .prepare(
          `INSERT INTO sessions(agent_id, source, source_mark, indexed_seq, last_anchor_seq,
             tail_assistant_seq, text_chars, message_count, embedded_chars, embedded_model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          input.session.agentId,
          input.session.source,
          input.session.sourceMark,
          input.session.indexedSeq,
          input.session.lastAnchorSeq,
          input.session.tailAssistantSeq,
          textChars,
          messageCount,
        );
    });
  }

  /**
   * Adds newly committed timeline messages to an indexed session.
   * `continuationText` extends the session's last message: the first new rows
   * continued an answer streamed as several rows.
   */
  appendMessages(input: {
    agentId: string;
    indexedSeq: number;
    lastAnchorSeq: number | null;
    tailAssistantSeq: number | null;
    continuationText: string | null;
    messages: readonly HistoryMessage[];
  }): void {
    this.transaction(() => {
      const session = this.getSession(input.agentId);
      if (!session) {
        throw new Error(`Cannot append to unindexed history session ${input.agentId}`);
      }
      let textChars = session.textChars;
      if (input.continuationText) {
        const last = this.db
          .prepare("SELECT id, text FROM messages WHERE agent_id = ? ORDER BY ordinal DESC LIMIT 1")
          .get(input.agentId);
        if (last) {
          const previous = last.text as string;
          const next = `${previous}${input.continuationText}`.slice(0, MAX_INDEXED_MESSAGE_CHARS);
          this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(next, toNumber(last.id));
          textChars += next.length - previous.length;
        }
      }
      const appended = this.insertMessages(input.agentId, input.messages, {
        ordinal: session.messageCount,
        textChars,
      });
      this.db
        .prepare(
          `UPDATE sessions SET indexed_seq = ?, last_anchor_seq = ?, tail_assistant_seq = ?,
             text_chars = ?, message_count = ?
           WHERE agent_id = ?`,
        )
        .run(
          input.indexedSeq,
          input.lastAnchorSeq,
          input.tailAssistantSeq,
          appended.textChars,
          appended.messageCount,
          input.agentId,
        );
    });
  }

  deleteSession(agentId: string): void {
    this.transaction(() => this.deleteSessionRows(agentId));
  }

  /**
   * Sessions containing `token` and how many of their messages do. The
   * per-message count is the term frequency the keyword ranking saturates.
   */
  countMatchingMessages(token: string): Map<string, number> {
    const rows =
      token.length >= TRIGRAM_MIN_CHARS
        ? this.db
            .prepare(
              `SELECT m.agent_id AS agent_id, count(*) AS n
               FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
               WHERE messages_fts MATCH ? GROUP BY m.agent_id`,
            )
            .all(ftsPhrase(token))
        : this.db
            .prepare(
              `SELECT agent_id, count(*) AS n FROM messages
               WHERE text LIKE ? ESCAPE '\\' GROUP BY agent_id`,
            )
            .all(`%${escapeLike(token)}%`);
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.agent_id as string, toNumber(row.n));
    return counts;
  }

  /** Messages of one session containing any of `tokens`, in session order. */
  listMatchingMessages(agentId: string, tokens: readonly string[]): StoredHistoryMessage[] {
    if (tokens.length === 0) return [];
    const clauses = tokens.map(() => "text LIKE ? ESCAPE '\\'").join(" OR ");
    return this.db
      .prepare(`SELECT * FROM messages WHERE agent_id = ? AND (${clauses}) ORDER BY ordinal`)
      .all(agentId, ...tokens.map((token) => `%${escapeLike(token)}%`))
      .map(toStoredMessage);
  }

  listMessages(agentId: string): StoredHistoryMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY ordinal")
      .all(agentId)
      .map(toStoredMessage);
  }

  getMessage(id: number): StoredHistoryMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? toStoredMessage(row) : null;
  }

  getFirstMessage(agentId: string, role: HistoryMessageRole): StoredHistoryMessage | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE agent_id = ? AND role = ? ORDER BY ordinal LIMIT 1")
      .get(agentId, role);
    return row ? toStoredMessage(row) : null;
  }

  getLastMessage(agentId: string, role: HistoryMessageRole): StoredHistoryMessage | null {
    const row = this.db
      .prepare(
        "SELECT * FROM messages WHERE agent_id = ? AND role = ? ORDER BY ordinal DESC LIMIT 1",
      )
      .get(agentId, role);
    return row ? toStoredMessage(row) : null;
  }

  listChunks(agentId: string): StoredEmbeddingChunk[] {
    return this.db
      .prepare("SELECT * FROM chunks WHERE agent_id = ? ORDER BY window_index")
      .all(agentId)
      .map(toStoredChunk);
  }

  listAllChunks(): StoredEmbeddingChunk[] {
    return this.db.prepare("SELECT * FROM chunks").all().map(toStoredChunk);
  }

  /** Stores a session's embedding chunks and the text length they describe. */
  replaceChunks(input: {
    agentId: string;
    chunks: readonly HistoryChunkInput[];
    embeddedChars: number;
    model: string;
  }): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM chunks WHERE agent_id = ?").run(input.agentId);
      const insert = this.db.prepare(
        "INSERT INTO chunks(agent_id, window_index, message_id, text_hash, vector) VALUES (?, ?, ?, ?, ?)",
      );
      for (const chunk of input.chunks) {
        insert.run(
          input.agentId,
          chunk.window,
          chunk.messageId,
          chunk.textHash,
          vectorToBlob(chunk.vector),
        );
      }
      this.db
        .prepare("UPDATE sessions SET embedded_chars = ?, embedded_model = ? WHERE agent_id = ?")
        .run(input.embeddedChars, input.model, input.agentId);
    });
  }

  private insertMessages(
    agentId: string,
    messages: readonly HistoryMessage[],
    start: { ordinal: number; textChars: number },
  ): { textChars: number; messageCount: number } {
    const insert = this.db.prepare(
      "INSERT INTO messages(agent_id, ordinal, role, seq, anchor_seq, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let ordinal = start.ordinal;
    let textChars = start.textChars;
    for (const message of messages) {
      insert.run(agentId, ordinal, message.role, message.seq, message.anchorSeq, message.text);
      ordinal += 1;
      textChars += message.text.length;
    }
    return { textChars, messageCount: ordinal };
  }

  private deleteSessionRows(agentId: string): void {
    this.db.prepare("DELETE FROM messages WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM chunks WHERE agent_id = ?").run(agentId);
    this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toSessionRecord(row: Record<string, unknown>): HistorySessionRecord {
  return {
    agentId: row.agent_id as string,
    source: row.source as HistorySessionSource,
    sourceMark: row.source_mark as string,
    indexedSeq: toNumber(row.indexed_seq),
    lastAnchorSeq: nullableNumber(row.last_anchor_seq),
    tailAssistantSeq: nullableNumber(row.tail_assistant_seq),
    textChars: toNumber(row.text_chars),
    messageCount: toNumber(row.message_count),
    embeddedChars: nullableNumber(row.embedded_chars),
    embeddedModel: (row.embedded_model as string | null) ?? null,
  };
}

function toStoredMessage(row: Record<string, unknown>): StoredHistoryMessage {
  return {
    id: toNumber(row.id),
    agentId: row.agent_id as string,
    ordinal: toNumber(row.ordinal),
    role: row.role as HistoryMessageRole,
    text: row.text as string,
    seq: nullableNumber(row.seq),
    anchorSeq: nullableNumber(row.anchor_seq),
  };
}

function toStoredChunk(row: Record<string, unknown>): StoredEmbeddingChunk {
  return {
    agentId: row.agent_id as string,
    window: toNumber(row.window_index),
    messageId: toNumber(row.message_id),
    textHash: row.text_hash as string,
    vector: blobToVector(row.vector),
  };
}
