import {
  EPHEMERAL_EVENT_TYPES,
  type HubEvent,
  SessionEvent,
  type SessionEventType,
  type SessionId,
} from "@loom/protocol";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ftsQuery, searchableText } from "./searchText.ts";

/** Bump when searchableText changes, so existing logs are indexed again. */
const SEARCH_VERSION = "1";

export interface SearchHit {
  seq: number;
  at: number;
  sessionId: SessionId;
  type: SessionEventType;
  /** The matching text with each hit between \u0001 and \u0002. */
  snippet: string;
}

const EPHEMERAL = new Set<SessionEventType>(EPHEMERAL_EVENT_TYPES);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  body       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON events (session_id, seq);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface Row {
  seq: number;
  at: number;
  session_id: string;
  body: string;
}

export interface ReadOptions {
  sessionIds?: readonly SessionId[] | undefined;
  limit?: number | undefined;
}

/**
 * The hub's append-only event log (ADR-0003), on Node's built-in SQLite so release builds carry
 * no native module.
 */
export class EventLog {
  readonly hubId: string;
  #db: DatabaseSync;
  #insert: StatementSync;
  #index: StatementSync;
  #head: number;

  constructor(file: string, hubId: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.hubId = hubId;
    this.#db = new DatabaseSync(file);
    if (file !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
    this.#insert = this.#db.prepare("INSERT INTO events (at, session_id, type, body) VALUES (?, ?, ?, ?)");
    this.#db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS event_text USING fts5(text, session_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
    this.#index = this.#db.prepare("INSERT INTO event_text (rowid, text, session_id) VALUES (?, ?, ?)");
    this.#ensureIndex();
    const head = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events").get() as { head: number };
    this.#head = Number(head.head);
  }

  head(): number {
    return this.#head;
  }

  /**
   * Validates and appends one event. Throws on an invalid event, which is always a hub bug, and on
   * ephemeral event types, which must be published without being logged.
   */
  append(sessionId: SessionId, event: SessionEvent, at: number = Date.now()): HubEvent {
    if (EPHEMERAL.has(event.type)) throw new Error(`event type ${event.type} is ephemeral and must not be logged`);
    const valid = SessionEvent.parse(event);
    const result = this.#insert.run(at, sessionId, valid.type, JSON.stringify(valid));
    this.#head = Number(result.lastInsertRowid);
    const text = searchableText(valid);
    if (text) this.#index.run(this.#head, text, sessionId);
    return { seq: this.#head, at, hubId: this.hubId, sessionId, event: valid };
  }

  /** Events with seq greater than `since`, oldest first. */
  readSince(since: number, opts: ReadOptions = {}): HubEvent[] {
    const limit = opts.limit ?? -1;
    let rows: Row[];
    if (opts.sessionIds && opts.sessionIds.length > 0) {
      const marks = opts.sessionIds.map(() => "?").join(", ");
      rows = this.#db
        .prepare(`SELECT seq, at, session_id, body FROM events WHERE seq > ? AND session_id IN (${marks}) ORDER BY seq LIMIT ?`)
        .all(since, ...opts.sessionIds, limit) as unknown as Row[];
    } else {
      rows = this.#db
        .prepare("SELECT seq, at, session_id, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(since, limit) as unknown as Row[];
    }
    return rows.map((r) => this.#toHubEvent(r));
  }

  /** The last `n` events of one session, oldest first. */
  readTail(sessionId: SessionId, n: number): HubEvent[] {
    const rows = this.#db
      .prepare("SELECT seq, at, session_id, body FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, n) as unknown as Row[];
    return rows.reverse().map((r) => this.#toHubEvent(r));
  }

  /** Visits every event in order without loading the whole log at once. */
  forEach(visit: (e: HubEvent) => void, pageSize = 1000): void {
    let since = 0;
    for (;;) {
      const page = this.readSince(since, { limit: pageSize });
      for (const e of page) visit(e);
      if (page.length < pageSize) return;
      since = page[page.length - 1]!.seq;
    }
  }

  /** Words across sessions, newest first. The index is a projection of the log (ADR-0003). */
  search(query: string, opts: { sessionId?: SessionId | undefined; limit?: number } = {}): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.#db
      .prepare(
        `SELECT e.seq, e.at, e.session_id, e.type, snippet(event_text, 0, char(1), char(2), '…', 14) AS snippet
         FROM event_text JOIN events e ON e.seq = event_text.rowid
         WHERE event_text MATCH ? ${opts.sessionId ? "AND event_text.session_id = ?" : ""}
         ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(...(opts.sessionId ? [match, opts.sessionId, limit] : [match, limit])) as unknown as Array<{ seq: number; at: number; session_id: string; type: SessionEventType; snippet: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), at: Number(r.at), sessionId: r.session_id, type: r.type, snippet: r.snippet }));
  }

  /** Indexes the whole log again when the index is new or its version changed. */
  #ensureIndex(): void {
    const version = (this.#db.prepare("SELECT value FROM meta WHERE key = 'search_version'").get() as { value?: string } | undefined)?.value;
    if (version === SEARCH_VERSION) return;
    this.#db.exec("DELETE FROM event_text");
    this.#db.exec("BEGIN");
    try {
      this.forEach((e) => {
        const text = searchableText(e.event);
        if (text) this.#index.run(e.seq, text, e.sessionId);
      }, 2000);
      this.#db.prepare("INSERT INTO meta (key, value) VALUES ('search_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SEARCH_VERSION);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.#db.close();
  }

  #toHubEvent(r: Row): HubEvent {
    return {
      seq: Number(r.seq),
      at: Number(r.at),
      hubId: this.hubId,
      sessionId: r.session_id,
      event: JSON.parse(r.body) as SessionEvent,
    };
  }
}
