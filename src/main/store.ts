/**
 * The store: SQLite, append-only where it matters.
 *
 * Two kinds of tables live here:
 *   - `events` and `heads`: the truth. Rows are inserted once, never updated.
 *   - everything else (`posts`, `profiles`, `follows`, `reactions`): derived
 *     views, rebuilt by replaying events. If they ever disagree with the log,
 *     the log wins and the views are thrown away.
 *
 * Node 24 ships SQLite in core, so there is no native build step and no ORM
 * between the app and its data.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateShape, verifyEvent } from "../core/events";
import { verifyLog } from "../core/log";
import type {
  Event,
  EventBody,
  EventKind,
  IngestResult,
  LogHead,
  PostView,
  ProfileView,
  Stats,
  VerifyReport,
} from "../core/types";
import { ZERO_HASH } from "../core/canonical";

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  author      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  prev        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  sig         TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(author, seq)
);
CREATE INDEX IF NOT EXISTS events_author_seq ON events(author, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS heads (
  author TEXT PRIMARY KEY,
  seq    INTEGER NOT NULL,
  id     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  author     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  bio        TEXT NOT NULL DEFAULT '',
  hue        INTEGER NOT NULL DEFAULT 200,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  author         TEXT NOT NULL,
  reply_to       TEXT,
  root           TEXT,
  text           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  edited_at      INTEGER,
  seq            INTEGER NOT NULL,
  retracted_at   INTEGER,
  retracted_seq  INTEGER,
  retract_reason TEXT,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reply_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author ON posts(author, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_reply ON posts(reply_to);
CREATE INDEX IF NOT EXISTS posts_root ON posts(root);

CREATE TABLE IF NOT EXISTS reactions (
  post_id TEXT NOT NULL,
  author  TEXT NOT NULL,
  emoji   TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  PRIMARY KEY (post_id, author)
);
CREATE INDEX IF NOT EXISTS reactions_post ON reactions(post_id);

CREATE TABLE IF NOT EXISTS follows (
  follower TEXT NOT NULL,
  target   TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (follower, target)
);
CREATE INDEX IF NOT EXISTS follows_target ON follows(target);

CREATE TABLE IF NOT EXISTS deferred (
  event_id TEXT PRIMARY KEY,
  target   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deferred_target ON deferred(target);

CREATE TABLE IF NOT EXISTS trail (
  target   TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (target, event_id)
);
CREATE INDEX IF NOT EXISTS trail_target ON trail(target);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface FeedOptions {
  limit?: number;
  includeSilt?: boolean;
  /** used to mark which posts the viewer already rippled */
  viewer?: string;
}

export class Store {
  readonly db: DatabaseSync;
  private stmt = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 4000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private prep(sql: string) {
    let statement = this.stmt.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.stmt.set(sql, statement);
    }
    return statement;
  }

  private all<T = Row>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.prep(sql).all(...params) as T[];
  }

  private one<T = Row>(sql: string, ...params: Array<string | number | null>): T | null {
    return (this.prep(sql).get(...params) as T | undefined) ?? null;
  }

  private run(sql: string, ...params: Array<string | number | null>) {
    return this.prep(sql).run(...params);
  }

  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // --------------------------------------------------------------- log heads

  head(author: string): LogHead | null {
    return this.one<LogHead>("SELECT author, seq, id FROM heads WHERE author = ?", author);
  }

  heads(): LogHead[] {
    return this.all<LogHead>("SELECT author, seq, id FROM heads ORDER BY author");
  }

  hasEvent(id: string): boolean {
    return Boolean(this.one("SELECT 1 AS ok FROM events WHERE id = ?", id));
  }

  eventCount(): number {
    return Number(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n ?? 0);
  }

  /** The next free slot in an author's log. */
  nextSlot(author: string): { seq: number; prev: string } {
    const head = this.head(author);
    return head ? { seq: head.seq + 1, prev: head.id } : { seq: 0, prev: "" };
  }

  // ---------------------------------------------------------------- ingestion

  /**
   * Verify and append. Everything is checked before a byte is written: shape,
   * log position, previous link, signature. A peer can send us junk, but junk
   * never lands.
   */
  async ingest(event: Event): Promise<IngestResult> {
    const shape = validateShape(event, Number.POSITIVE_INFINITY);
    if (shape) return { status: "invalid", reason: shape };

    if (this.hasEvent(event.id)) return { status: "duplicate" };

    const head = this.head(event.author);
    const expectedSeq = head ? head.seq + 1 : 0;

    if (event.seq > expectedSeq) {
      return { status: "gap", reason: `expected seq ${expectedSeq}, got ${event.seq}` };
    }
    if (event.seq < expectedSeq) {
      return { status: "invalid", reason: "fork: seq already claimed with a different event" };
    }
    const expectedPrev = head ? head.id : "";
    if (event.prev !== expectedPrev) {
      return { status: "invalid", reason: "prev does not match this author's head" };
    }
    if (!(await verifyEvent(event))) {
      return { status: "invalid", reason: "signature does not match author and content" };
    }

    this.applyEvent(event);
    return { status: "added" };
  }

  private applyEvent(event: Event): void {
    this.tx(() => {
      this.run(
        `INSERT INTO events (id, author, seq, prev, kind, body, created_at, sig, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.author,
        event.seq,
        event.prev,
        event.kind,
        JSON.stringify(event.body),
        event.createdAt,
        event.sig,
        Date.now(),
      );

      this.run(
        `INSERT INTO heads (author, seq, id) VALUES (?, ?, ?)
         ON CONFLICT(author) DO UPDATE SET seq = excluded.seq, id = excluded.id`,
        event.author,
        event.seq,
        event.id,
      );

      this.applyDerived(event);
    });
  }

  /**
   * Update the readable view. References may point at events we have not seen
   * yet (the network is a DAG, arrival order is arbitrary), so anything that
   * cannot be applied yet is parked and replayed when its parent lands.
   */
  private applyDerived(event: Event): void {
    const body = event.body ?? {};

    // Provenance index: every event that touched a given post.
    const trailTarget = event.kind === "post" ? event.id : (body.target ?? "");
    if (trailTarget) {
      this.run(
        "INSERT OR IGNORE INTO trail (target, event_id) VALUES (?, ?)",
        trailTarget,
        event.id,
      );
    }

    switch (event.kind) {
      case "post": {
        const replyTo = body.replyTo ?? null;
        const parent = replyTo ? (this.one<{ root: string | null }>("SELECT root FROM posts WHERE id = ?", replyTo) ?? null) : null;
        const root = replyTo ? (parent?.root ?? replyTo) : null;

        this.run(
          `INSERT INTO posts (id, author, reply_to, root, text, created_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          event.id,
          event.author,
          replyTo,
          root,
          body.text ?? "",
          event.createdAt,
          event.seq,
        );
        if (replyTo && parent) {
          this.run("UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?", replyTo);
        }
        this.replayDeferred(event.id);
        break;
      }

      case "edit": {
        const target = body.target ?? "";
        const result = this.run(
          `UPDATE posts SET text = ?, edited_at = ?, seq = ?
           WHERE id = ? AND author = ? AND retracted_at IS NULL`,
          body.text ?? "",
          event.createdAt,
          event.seq,
          target,
          event.author,
        );
        if (result.changes === 0) this.defer(event.id, target);
        break;
      }

      case "retract": {
        const target = body.target ?? "";
        const result = this.run(
          `UPDATE posts SET retracted_at = ?, retracted_seq = ?, retract_reason = ?
           WHERE id = ? AND author = ? AND retracted_at IS NULL`,
          event.createdAt,
          event.seq,
          body.reason ?? null,
          target,
          event.author,
        );
        if (result.changes === 0) this.defer(event.id, target);
        break;
      }

      case "reaction": {
        const target = body.target ?? "";
        const post = this.one<{ id: string }>("SELECT id FROM posts WHERE id = ?", target);
        if (!post) {
          this.defer(event.id, target);
          break;
        }
        if ((body.emoji ?? "") === "") {
          const removed = this.run("DELETE FROM reactions WHERE post_id = ? AND author = ?", target, event.author);
          if (removed.changes > 0) {
            this.run("UPDATE posts SET reaction_count = MAX(reaction_count - 1, 0) WHERE id = ?", target);
          }
        } else {
          const existing = this.one("SELECT 1 AS ok FROM reactions WHERE post_id = ? AND author = ?", target, event.author);
          this.run(
            `INSERT INTO reactions (post_id, author, emoji, seq) VALUES (?, ?, ?, ?)
             ON CONFLICT(post_id, author) DO UPDATE SET emoji = excluded.emoji, seq = excluded.seq`,
            target,
            event.author,
            body.emoji ?? "≈",
            event.seq,
          );
          if (!existing) {
            this.run("UPDATE posts SET reaction_count = reaction_count + 1 WHERE id = ?", target);
          }
        }
        break;
      }

      case "follow": {
        this.run(
          `INSERT INTO follows (follower, target, active, seq) VALUES (?, ?, ?, ?)
           ON CONFLICT(follower, target) DO UPDATE SET active = excluded.active, seq = excluded.seq`,
          event.author,
          body.target ?? "",
          body.unfollow ? 0 : 1,
          event.seq,
        );
        break;
      }

      case "profile": {
        this.run(
          `INSERT INTO profiles (author, name, bio, hue, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(author) DO UPDATE SET
             name = excluded.name,
             bio = excluded.bio,
             hue = excluded.hue,
             seq = excluded.seq,
             updated_at = excluded.updated_at
           WHERE excluded.seq > profiles.seq`,
          event.author,
          body.name ?? "anon",
          body.bio ?? "",
          body.hue ?? 200,
          event.seq,
          event.createdAt,
        );
        break;
      }
    }
  }

  private defer(eventId: string, target: string): void {
    if (!target) return;
    this.run("INSERT OR IGNORE INTO deferred (event_id, target) VALUES (?, ?)", eventId, target);
  }

  private replayDeferred(postId: string): void {
    const pending = this.all<{ event_id: string }>("SELECT event_id FROM deferred WHERE target = ?", postId);
    for (const { event_id } of pending) {
      const row = this.one<{ author: string; seq: number; prev: string; kind: EventKind; body: string; created_at: number; sig: string; id: string }>(
        "SELECT * FROM events WHERE id = ?",
        event_id,
      );
      if (!row) continue;
      const event: Event = {
        id: row.id,
        author: row.author,
        seq: row.seq,
        prev: row.prev,
        kind: row.kind,
        body: JSON.parse(row.body) as EventBody,
        createdAt: row.created_at,
        sig: row.sig,
      };
      this.run("DELETE FROM deferred WHERE event_id = ?", event_id);
      this.applyDerived(event);
    }
  }

  // ----------------------------------------------------------------- queried

  /** Top-level posts plus every reply beneath them, newest thread first. */
  feed(options: FeedOptions = {}): { top: PostView[]; replies: PostView[] } {
    const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
    const silt = options.includeSilt ? 1 : 0;
    const viewer = options.viewer ?? "";

    const topRows = this.all<Row>(
      `SELECT p.*, EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
       FROM posts p
       WHERE p.reply_to IS NULL AND (? = 1 OR p.retracted_at IS NULL)
       ORDER BY p.created_at DESC LIMIT ?`,
      viewer,
      silt,
      limit,
    );

    const ids = topRows.map((row) => String(row.id));
    const replies = ids.length
      ? this.all<Row>(
          `SELECT p.*, EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
           FROM posts p
           WHERE p.root IN (${ids.map(() => "?").join(",")})
             AND (? = 1 OR p.retracted_at IS NULL)
           ORDER BY p.created_at ASC`,
          viewer,
          ...ids,
          silt,
        )
      : [];

    return { top: topRows.map(toPostView), replies: replies.map(toPostView) };
  }

  postsByAuthor(author: string, limit = 100): PostView[] {
    return this.all<Row>(
      `SELECT * FROM posts WHERE author = ? ORDER BY created_at DESC LIMIT ?`,
      author,
      limit,
    ).map(toPostView);
  }

  profile(author: string): ProfileView | null {
    const row = this.one<Row>("SELECT * FROM profiles WHERE author = ?", author);
    return row ? toProfileView(row) : null;
  }

  profilesFor(authors: string[]): Record<string, ProfileView> {
    const unique = [...new Set(authors)].filter(Boolean);
    if (unique.length === 0) return {};
    const rows = this.all<Row>(
      `SELECT * FROM profiles WHERE author IN (${unique.map(() => "?").join(",")})`,
      ...unique,
    );
    const out: Record<string, ProfileView> = {};
    for (const row of rows) {
      const profile = toProfileView(row);
      out[profile.pubkey] = profile;
    }
    return out;
  }

  following(author: string): string[] {
    return this.all<{ target: string }>(
      "SELECT target FROM follows WHERE follower = ? AND active = 1 ORDER BY target",
      author,
    ).map((row) => row.target);
  }

  followers(author: string): string[] {
    return this.all<{ follower: string }>(
      "SELECT follower FROM follows WHERE target = ? AND active = 1 ORDER BY follower",
      author,
    ).map((row) => row.follower);
  }

  stats(): Stats {
    const one = (sql: string) => Number(this.one<{ n: number }>(sql)?.n ?? 0);
    return {
      authors: one("SELECT COUNT(*) AS n FROM heads"),
      posts: one("SELECT COUNT(*) AS n FROM posts"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      follows: one("SELECT COUNT(*) AS n FROM follows WHERE active = 1"),
      retracted: one("SELECT COUNT(*) AS n FROM posts WHERE retracted_at IS NOT NULL"),
      reactions: one("SELECT COUNT(*) AS n FROM reactions"),
    };
  }

  eventsFor(author: string, limit = 200): Event[] {
    return this.all<Row>(
      "SELECT * FROM events WHERE author = ? ORDER BY seq DESC LIMIT ?",
      author,
      limit,
    ).map(toEvent);
  }

  rangeEvents(author: string, from: number, to: number): Event[] {
    return this.all<Row>(
      "SELECT * FROM events WHERE author = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
      author,
      from,
      to,
    ).map(toEvent);
  }

  /** Every event that touched this post: written, edited, retracted, rippled. */
  trailFor(target: string): Event[] {
    return this.all<Row>(
      `SELECT e.* FROM trail t JOIN events e ON e.id = t.event_id
       WHERE t.target = ? ORDER BY e.received_at ASC, e.seq ASC`,
      target,
    ).map(toEvent);
  }

  recentEvents(limit = 50): Event[] {
    return this.all<Row>(
      "SELECT * FROM events ORDER BY received_at DESC LIMIT ?",
      limit,
    ).map(toEvent);
  }

  /**
   * Re-verify every author's log from seq 0: hash chain, links, signatures.
   * This is the answer to "why should I believe any of it?".
   */
  async verifyAll(): Promise<VerifyReport> {
    const started = Date.now();
    const authors = this.all<{ author: string }>("SELECT DISTINCT author FROM events ORDER BY author");
    const errors: VerifyReport["errors"] = [];
    let total = 0;

    for (const { author } of authors) {
      const events = this.all<Row>(
        "SELECT * FROM events WHERE author = ? ORDER BY seq ASC",
        author,
      ).map(toEvent);
      total += events.length;
      errors.push(...(await verifyLog(events)));
    }

    return {
      ok: errors.length === 0,
      authors: authors.length,
      events: total,
      errors,
      checkedAt: Date.now(),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Show, without touching the real data, what happens if someone edits the
   * database. Two modes: erase an event, or rewrite one event's text in place.
   */
  async simulateBreach(
    author: string,
    mode: "erase" | "rewrite",
  ): Promise<VerifyReport & { removedSeq: number | null }> {
    const started = Date.now();
    const events = this.all<Row>("SELECT * FROM events WHERE author = ? ORDER BY seq ASC", author).map(
      toEvent,
    );

    if (events.length === 0) {
      return {
        ok: true,
        authors: 0,
        events: 0,
        errors: [],
        checkedAt: Date.now(),
        durationMs: 0,
        removedSeq: null,
      };
    }

    let damaged = events;
    let removedSeq: number | null = null;

    if (mode === "erase") {
      const index = Math.floor(events.length / 2);
      removedSeq = events[index].seq;
      damaged = events.filter((_, i) => i !== index);
    } else {
      const index = events.length - 1;
      damaged = events.map((event, i) =>
        i === index ? { ...event, body: { ...event.body, text: "this was quietly rewritten" } } : event,
      );
    }

    const errors = await verifyLog(damaged);
    return {
      ok: errors.length === 0,
      authors: 1,
      events: damaged.length,
      errors,
      checkedAt: Date.now(),
      durationMs: Date.now() - started,
      removedSeq,
    };
  }

  /** Throw away derived tables and replay the log. The log is never touched. */
  rebuild(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM posts; DELETE FROM profiles; DELETE FROM follows; DELETE FROM reactions; DELETE FROM deferred; DELETE FROM trail;");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const events = this.all<Row>("SELECT * FROM events ORDER BY received_at ASC, seq ASC").map(toEvent);
    for (const event of events) {
      this.tx(() => this.applyDerived(event));
    }
  }
}

function toPostView(row: Row): PostView {
  return {
    id: String(row.id),
    author: String(row.author),
    text: String(row.text),
    replyTo: row.reply_to ? String(row.reply_to) : null,
    root: row.root ? String(row.root) : null,
    createdAt: Number(row.created_at),
    editedAt: row.edited_at ? Number(row.edited_at) : null,
    seq: Number(row.seq),
    retracted: Boolean(row.retracted_at),
    retractReason: row.retract_reason ? String(row.retract_reason) : null,
    reactions: Number(row.reaction_count ?? 0),
    replyCount: Number(row.reply_count ?? 0),
    viewerReacted: Boolean(row.mine),
    verified: true,
  };
}

function toProfileView(row: Row): ProfileView {
  return {
    pubkey: String(row.author),
    name: String(row.name),
    bio: String(row.bio ?? ""),
    hue: Number(row.hue ?? 200),
    seq: Number(row.seq),
  };
}

function toEvent(row: Row): Event {
  return {
    id: String(row.id),
    author: String(row.author),
    seq: Number(row.seq),
    prev: String(row.prev),
    kind: String(row.kind) as EventKind,
    body: JSON.parse(String(row.body)) as EventBody,
    createdAt: Number(row.created_at),
    sig: String(row.sig),
  };
}

export { ZERO_HASH };
