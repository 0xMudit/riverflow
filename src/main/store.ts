/**
 * The store: SQLite, append-only where it matters.
 *
 * Two kinds of tables live here:
 *   - `events` and `chains`: the truth. Rows are inserted once, never updated.
 *   - everything else (`posts`, `profiles`, `follows`, `reactions`): derived
 *     views, rebuilt by replaying events. If they ever disagree with the log,
 *     the log wins and the views are thrown away.
 *
 * A log is a chain per *device*, not per person: one identity may write from
 * a laptop and a phone without either machine forking the other's history.
 * The root key's chain has the empty device; a delegated device has its own
 * chain, and the person who owns it signs a `device` event naming the key.
 *
 * Node 24 ships SQLite in core, so there is no native build step and no ORM
 * between the app and its data.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateShape, verifyEvent } from "../core/events";
import { verifyLog } from "../core/log";
import { merkleProof, merkleRoot, type Checkpoint, type MerkleProof } from "../core/merkle";
import { isBlobRef, type BlobRef } from "../core/blobs";
import type {
  DeviceView,
  Event,
  EventBody,
  EventKind,
  FeedPage,
  IngestResult,
  KnownPeer,
  LogHead,
  NotificationView,
  PostView,
  ProfileView,
  Stats,
  ThreadView,
  VerifyReport,
} from "../core/types";
import { ZERO_HASH } from "../core/canonical";

type Row = Record<string, unknown>;

/** What SQLite will take as a bound parameter. */
type SqlParam = string | number | null | Uint8Array;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  author      TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL,
  prev        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  sig         TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(author, device, seq)
);

CREATE TABLE IF NOT EXISTS chains (
  author TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  seq    INTEGER NOT NULL,
  id     TEXT NOT NULL,
  PRIMARY KEY (author, device)
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

-- What happened to you. Derived from events and rebuildable; the events
-- themselves are untouched when you mark these read.
CREATE TABLE IF NOT EXISTS notifications (
  event_id   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  post_id    TEXT,
  text       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_recipient
  ON notifications(recipient, created_at DESC);

-- Local moderation. Never an event, never shared: what you see is your choice.
CREATE TABLE IF NOT EXISTS mutes (
  target     TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- The address book. A node that has met someone can dial them again.
CREATE TABLE IF NOT EXISTS known_peers (
  address   TEXT PRIMARY KEY,
  node_id   TEXT,
  last_seen INTEGER NOT NULL,
  failures  INTEGER NOT NULL DEFAULT 0,
  next_try  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Devices an identity has authorised to write on its behalf.
CREATE TABLE IF NOT EXISTS devices (
  author    TEXT NOT NULL,
  device    TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  seq       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (author, device)
);

-- Merkle checkpoints: a signed root over an author's chain at a seq.
CREATE TABLE IF NOT EXISTS checkpoints (
  author      TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT '',
  root        TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  sig         TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (author, device, root)
);
CREATE INDEX IF NOT EXISTS checkpoints_author ON checkpoints(author, device, seq DESC);

-- Media, addressed by the hash of its bytes.
CREATE TABLE IF NOT EXISTS blobs (
  hash     TEXT PRIMARY KEY,
  size     INTEGER NOT NULL,
  type     TEXT NOT NULL,
  width    INTEGER,
  height   INTEGER,
  data     BLOB NOT NULL,
  added_at INTEGER NOT NULL
);

-- Who this node wants to hear from. Replaces "a head for every author".
CREATE TABLE IF NOT EXISTS subscriptions (
  author    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Heads we have heard about but do not hold yet.
CREATE TABLE IF NOT EXISTS wanted (
  author TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  seq    INTEGER NOT NULL,
  at     INTEGER NOT NULL,
  PRIMARY KEY (author, device)
);
`;

/**
 * Indexes are made after the migration, never before: an old store still has
 * the previous shape of `events`, and an index on a column that does not exist
 * yet stops the whole database from opening.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS events_chain ON events(author, device, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at DESC);
CREATE INDEX IF NOT EXISTS checkpoints_author ON checkpoints(author, device, seq DESC);
`;

export interface FeedOptions {
  limit?: number;
  includeSilt?: boolean;
  /** used to mark which posts the viewer already rippled */
  viewer?: string;
  /** continue after this post; the cursor comes from the previous page */
  before?: { createdAt: number; id: string } | null;
  /** "new" is chronological; "flow" is ranked locally, on this machine */
  sort?: "new" | "flow";
  /** fixed clock for deterministic ranking (tests) */
  now?: number;
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
    this.migrate();
    this.db.exec(INDEXES);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Older stores kept one chain per author and had no device column. Move
   * them forward without losing a single event: the rows are copied, the old
   * tables are dropped, and the log is re-verified afterwards.
   */
  private migrate(): void {
    const columns = this.all<{ name: string }>("PRAGMA table_info(events)");
    if (columns.some((column) => column.name === "device")) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS chains;

        CREATE TABLE events_migrated (
          id          TEXT PRIMARY KEY,
          author      TEXT NOT NULL,
          device      TEXT NOT NULL DEFAULT '',
          seq         INTEGER NOT NULL,
          prev        TEXT NOT NULL,
          kind        TEXT NOT NULL,
          body        TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          sig         TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          UNIQUE(author, device, seq)
        );
        INSERT INTO events_migrated
          (id, author, device, seq, prev, kind, body, created_at, sig, received_at)
          SELECT id, author, '', seq, prev, kind, body, created_at, sig, received_at FROM events;
        DROP TABLE events;
        ALTER TABLE events_migrated RENAME TO events;

        CREATE TABLE chains_migrated (
          author TEXT NOT NULL,
          device TEXT NOT NULL DEFAULT '',
          seq    INTEGER NOT NULL,
          id     TEXT NOT NULL,
          PRIMARY KEY (author, device)
        );
        INSERT INTO chains_migrated (author, device, seq, id)
          SELECT author, '', seq, id FROM heads;
        DROP TABLE heads;
        ALTER TABLE chains_migrated RENAME TO chains;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_chain ON events(author, device, seq);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS events_received ON events(received_at DESC);
    `);
  }

  private prep(sql: string) {
    let statement = this.stmt.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.stmt.set(sql, statement);
    }
    return statement;
  }

  private all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.prep(sql).all(...params) as T[];
  }

  private one<T = Row>(sql: string, ...params: SqlParam[]): T | null {
    return (this.prep(sql).get(...params) as T | undefined) ?? null;
  }

  private run(sql: string, ...params: SqlParam[]) {
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

  head(author: string, device = ""): LogHead | null {
    return this.one<LogHead>(
      "SELECT author, device, seq, id FROM chains WHERE author = ? AND device = ?",
      author,
      device,
    );
  }

  heads(): LogHead[] {
    return this.all<LogHead>("SELECT author, device, seq, id FROM chains ORDER BY author, device");
  }

  hasEvent(id: string): boolean {
    return Boolean(this.one("SELECT 1 AS ok FROM events WHERE id = ?", id));
  }

  eventCount(): number {
    return Number(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n ?? 0);
  }

  /** The next free slot in a chain. */
  nextSlot(author: string, device = ""): { seq: number; prev: string } {
    const head = this.head(author, device);
    return head ? { seq: head.seq + 1, prev: head.id } : { seq: 0, prev: "" };
  }

  // ---------------------------------------------------------------- ingestion

  /**
   * Verify and append. Everything is checked before a byte is written: shape,
   * log position, previous link, signature, and — for a delegated device —
   * that the person named in the event actually authorised that key.
   */
  async ingest(event: Event): Promise<IngestResult> {
    const shape = validateShape(event, Number.POSITIVE_INFINITY);
    if (shape) return { status: "invalid", reason: shape };

    if (this.hasEvent(event.id)) return { status: "duplicate" };

    const device = event.device ?? "";
    if (device && !this.deviceRegistered(event.author, device)) {
      return { status: "invalid", reason: "this device was never authorised by its owner" };
    }

    const head = this.head(event.author, device);
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
        `INSERT INTO events (id, author, device, seq, prev, kind, body, created_at, sig, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.author,
        event.device ?? "",
        event.seq,
        event.prev,
        event.kind,
        JSON.stringify(event.body),
        event.createdAt,
        event.sig,
        Date.now(),
      );

      this.run(
        `INSERT INTO chains (author, device, seq, id) VALUES (?, ?, ?, ?)
         ON CONFLICT(author, device) DO UPDATE SET seq = excluded.seq, id = excluded.id`,
        event.author,
        event.device ?? "",
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
        if (replyTo) {
          const owner = this.one<{ author: string }>("SELECT author FROM posts WHERE id = ?", replyTo);
          if (owner) {
            this.notify("reply", event, owner.author, replyTo, body.text ?? "");
          }
        }
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
        const post = this.one<{ id: string; author: string }>("SELECT id, author FROM posts WHERE id = ?", target);
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
        this.notify("reaction", event, post.author, target, body.emoji ?? "≈");
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
        if (!body.unfollow) {
          this.notify("follow", event, body.target ?? "", null, "");
        }
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

      case "device": {
        this.run(
          `INSERT INTO devices (author, device, name, seq, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(author, device) DO UPDATE SET name = excluded.name, seq = excluded.seq`,
          event.author,
          body.device ?? "",
          body.name ?? "",
          event.seq,
          event.createdAt,
        );
        break;
      }
    }
  }

  private notify(
    kind: NotificationView["kind"],
    event: Event,
    recipient: string,
    postId: string | null,
    text: string,
  ): void {
    if (!recipient || recipient === event.author) return;
    this.run(
      `INSERT OR IGNORE INTO notifications (event_id, kind, actor, recipient, post_id, text, created_at, seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      event.id,
      kind,
      event.author,
      recipient,
      postId,
      text.slice(0, 200),
      event.createdAt,
    );
  }

  private defer(eventId: string, target: string): void {
    if (!target) return;
    this.run("INSERT OR IGNORE INTO deferred (event_id, target) VALUES (?, ?)", eventId, target);
  }

  private replayDeferred(postId: string): void {
    const pending = this.all<{ event_id: string }>("SELECT event_id FROM deferred WHERE target = ?", postId);
    for (const { event_id } of pending) {
      const row = this.one<Row>("SELECT * FROM events WHERE id = ?", event_id);
      if (!row) continue;
      this.run("DELETE FROM deferred WHERE event_id = ?", event_id);
      this.applyDerived(toEvent(row));
    }
  }

  // ----------------------------------------------------------------- devices

  deviceRegistered(author: string, device: string): boolean {
    if (!device) return true;
    return Boolean(
      this.one("SELECT 1 AS ok FROM devices WHERE author = ? AND device = ?", author, device),
    );
  }

  devicesFor(author: string): DeviceView[] {
    return this.all<Row>(
      "SELECT * FROM devices WHERE author = ? ORDER BY created_at ASC",
      author,
    ).map((row) => ({
      device: String(row.device),
      name: String(row.name ?? ""),
      seq: Number(row.seq),
      createdAt: Number(row.created_at),
    }));
  }

  // -------------------------------------------------------------- checkpoints

  /** Remember a checkpoint somebody signed. */
  saveCheckpoint(checkpoint: Checkpoint, sig: string): void {
    this.run(
      `INSERT INTO checkpoints (author, device, root, seq, count, at, sig, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(author, device, root) DO UPDATE SET
         seq = excluded.seq, count = excluded.count, at = excluded.at, sig = excluded.sig`,
      checkpoint.author,
      checkpoint.device,
      checkpoint.root,
      checkpoint.seq,
      checkpoint.count,
      checkpoint.at,
      sig,
      Date.now(),
    );
  }

  latestCheckpoint(author: string, device = ""): (Checkpoint & { sig: string }) | null {
    const row = this.one<Row>(
      `SELECT * FROM checkpoints WHERE author = ? AND device = ? ORDER BY seq DESC LIMIT 1`,
      author,
      device,
    );
    return row ? toCheckpoint(row) : null;
  }

  checkpointsFor(author: string): (Checkpoint & { sig: string })[] {
    return this.all<Row>(
      "SELECT * FROM checkpoints WHERE author = ? ORDER BY seq DESC",
      author,
    ).map(toCheckpoint);
  }

  /** The event ids of a chain, in order — the leaves a Merkle root covers. */
  chainIds(author: string, device = "", from = 0, to = Number.MAX_SAFE_INTEGER): string[] {
    return this.all<{ id: string }>(
      "SELECT id FROM events WHERE author = ? AND device = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
      author,
      device,
      from,
      to,
    ).map((row) => row.id);
  }

  /** The Merkle root this node computes over a chain, or null if it has none. */
  async localRoot(author: string, device = ""): Promise<string | null> {
    const ids = this.chainIds(author, device);
    if (ids.length === 0) return null;
    return merkleRoot(ids);
  }

  /** An inclusion proof for one event in a chain. */
  async proofFor(author: string, device: string, seq: number): Promise<MerkleProof | null> {
    const ids = this.chainIds(author, device);
    const index = ids.findIndex((_, position) => position === seq);
    if (index < 0) return null;
    return merkleProof(ids, index);
  }

  // ------------------------------------------------------------------- blobs

  putBlob(ref: BlobRef, bytes: Uint8Array): void {
    this.run(
      `INSERT OR REPLACE INTO blobs (hash, size, type, width, height, data, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ref.hash,
      ref.size,
      ref.type,
      ref.width ?? null,
      ref.height ?? null,
      bytes,
      Date.now(),
    );
  }

  getBlob(hash: string): { ref: BlobRef; bytes: Uint8Array } | null {
    const row = this.one<Row>("SELECT * FROM blobs WHERE hash = ?", hash);
    if (!row) return null;
    return {
      ref: {
        hash: String(row.hash),
        size: Number(row.size),
        type: String(row.type),
        ...(row.width === null ? {} : { width: Number(row.width) }),
        ...(row.height === null ? {} : { height: Number(row.height) }),
      },
      bytes: new Uint8Array(row.data as Uint8Array),
    };
  }

  hasBlob(hash: string): boolean {
    return Boolean(this.one("SELECT 1 AS ok FROM blobs WHERE hash = ?", hash));
  }

  blobCount(): number {
    return Number(this.one<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")?.n ?? 0);
  }

  // ----------------------------------------------------------- subscriptions

  setSubscriptions(authors: string[]): void {
    const unique = [...new Set(authors)].filter(Boolean);
    this.tx(() => {
      this.run("DELETE FROM subscriptions");
      for (const author of unique) {
        this.run(
          "INSERT OR IGNORE INTO subscriptions (author, created_at) VALUES (?, ?)",
          author,
          Date.now(),
        );
      }
    });
  }

  subscriptions(): string[] {
    return this.all<{ author: string }>("SELECT author FROM subscriptions ORDER BY author").map(
      (row) => row.author,
    );
  }

  // ------------------------------------------------------------------ wanted

  /** A head we have heard about but do not hold yet. */
  wantChain(author: string, device: string, seq: number): void {
    this.run(
      `INSERT INTO wanted (author, device, seq, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(author, device) DO UPDATE SET seq = MAX(wanted.seq, excluded.seq), at = excluded.at`,
      author,
      device,
      seq,
      Date.now(),
    );
  }

  wanted(): Array<{ author: string; device: string; seq: number }> {
    return this.all<Row>("SELECT author, device, seq FROM wanted ORDER BY at DESC").map((row) => ({
      author: String(row.author),
      device: String(row.device),
      seq: Number(row.seq),
    }));
  }

  clearWant(author: string, device: string): void {
    this.run("DELETE FROM wanted WHERE author = ? AND device = ?", author, device);
  }

  // ----------------------------------------------------------------- queried

  /** Top-level posts plus every reply beneath them. */
  feed(options: FeedOptions = {}): FeedPage {
    const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
    const silt = options.includeSilt ? 1 : 0;
    const viewer = options.viewer ?? "";
    const sort = options.sort ?? "new";
    const now = options.now ?? Date.now();

    const select = `SELECT p.*,
        EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
      FROM posts p`;

    const visible = `WHERE p.reply_to IS NULL
        AND (? = 1 OR p.retracted_at IS NULL)
        AND p.author NOT IN (SELECT target FROM mutes)`;

    let topRows: Row[];
    let next: FeedPage["next"] = null;

    if (sort === "flow") {
      // Ranked here, on this machine: engagement, freshness, and the people you
      // chose to follow. No server sees this list and no profile is built of you.
      topRows = this.all<Row>(
        `${select}
         ${visible}
         ORDER BY (
           (p.reaction_count * 3.0 + p.reply_count * 5.0 +
            CASE WHEN EXISTS(
              SELECT 1 FROM follows f
              WHERE f.follower = ? AND f.target = p.author AND f.active = 1
            ) THEN 8.0 ELSE 0.0 END)
           / (1.0 + (? - p.created_at) / 3600000.0)
         ) DESC, p.created_at DESC, p.id DESC
         LIMIT ?`,
        viewer,
        silt,
        viewer,
        now,
        limit,
      );
    } else if (options.before) {
      topRows = this.all<Row>(
        `${select}
         ${visible}
           AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ?`,
        viewer,
        silt,
        options.before.createdAt,
        options.before.createdAt,
        options.before.id,
        limit,
      );
    } else {
      topRows = this.all<Row>(
        `${select}
         ${visible}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ?`,
        viewer,
        silt,
        limit,
      );
    }

    if (topRows.length === limit && sort === "new") {
      const last = topRows[topRows.length - 1];
      next = { createdAt: Number(last.created_at), id: String(last.id) };
    }

    const ids = topRows.map((row) => String(row.id));
    const replies = ids.length
      ? this.all<Row>(
          `SELECT p.*, EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
           FROM posts p
           WHERE p.root IN (${ids.map(() => "?").join(",")})
             AND (? = 1 OR p.retracted_at IS NULL)
             AND p.author NOT IN (SELECT target FROM mutes)
           ORDER BY p.created_at ASC`,
          viewer,
          ...ids,
          silt,
        )
      : [];

    return { top: topRows.map(toPostView), replies: replies.map(toPostView), next };
  }

  /** One thread: the root and everything beneath it, oldest first. */
  thread(postId: string, options: { includeSilt?: boolean; viewer?: string } = {}): ThreadView {
    const viewer = options.viewer ?? "";
    const silt = options.includeSilt ? 1 : 0;

    let cursor = this.one<Row>("SELECT id, reply_to FROM posts WHERE id = ?", postId);
    let guard = 0;
    while (cursor?.reply_to && guard++ < 64) {
      const parent = this.one<Row>("SELECT id, reply_to FROM posts WHERE id = ?", String(cursor.reply_to));
      if (!parent) break;
      cursor = parent;
    }

    const rootId = cursor ? String(cursor.id) : postId;
    const rows = this.all<Row>(
      `SELECT p.*, EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
       FROM posts p
       WHERE (p.id = ? OR p.root = ?)
         AND (? = 1 OR p.retracted_at IS NULL)
         AND p.author NOT IN (SELECT target FROM mutes)
       ORDER BY p.created_at ASC, p.id ASC`,
      viewer,
      rootId,
      rootId,
      silt,
    );

    const posts = rows.map(toPostView);
    return { root: posts.find((post) => post.id === rootId) ?? null, posts };
  }

  /** Case-insensitive substring search over stored words. */
  search(
    query: string,
    options: { limit?: number; includeSilt?: boolean; viewer?: string } = {},
  ): PostView[] {
    const text = query.trim();
    if (!text) return [];
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
    const escaped = text.replace(/[\\%_]/g, (character) => `\\${character}`);

    return this.all<Row>(
      `SELECT p.*, EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.author = ?) AS mine
       FROM posts p
       WHERE p.text LIKE ? ESCAPE '\\'
         AND (? = 1 OR p.retracted_at IS NULL)
         AND p.author NOT IN (SELECT target FROM mutes)
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
      options.viewer ?? "",
      `%${escaped}%`,
      options.includeSilt ? 1 : 0,
      limit,
    ).map(toPostView);
  }

  // ----------------------------------------------------------- notifications

  notifications(recipient: string, limit = 40): NotificationView[] {
    return this.all<Row>(
      `SELECT n.* FROM notifications n
       WHERE n.recipient = ?
         AND n.actor NOT IN (SELECT target FROM mutes)
       ORDER BY n.created_at DESC, n.event_id DESC
       LIMIT ?`,
      recipient,
      Math.min(Math.max(limit, 1), 200),
    ).map(toNotificationView);
  }

  unread(recipient: string): number {
    return Number(
      this.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notifications n
         WHERE n.recipient = ? AND n.seen = 0
           AND n.actor NOT IN (SELECT target FROM mutes)`,
        recipient,
      )?.n ?? 0,
    );
  }

  markNotificationsRead(recipient: string): void {
    this.run("UPDATE notifications SET seen = 1 WHERE recipient = ? AND seen = 0", recipient);
  }

  // --------------------------------------------------------------- moderation

  mute(target: string): void {
    this.run("INSERT OR IGNORE INTO mutes (target, created_at) VALUES (?, ?)", target, Date.now());
  }

  unmute(target: string): void {
    this.run("DELETE FROM mutes WHERE target = ?", target);
  }

  muted(): string[] {
    return this.all<{ target: string }>("SELECT target FROM mutes ORDER BY target").map(
      (row) => row.target,
    );
  }

  // -------------------------------------------------------------- address book

  knownPeers(): KnownPeer[] {
    return this.all<Row>("SELECT * FROM known_peers ORDER BY last_seen DESC").map(toKnownPeer);
  }

  rememberPeer(address: string, nodeId: string | null): void {
    this.run(
      `INSERT INTO known_peers (address, node_id, last_seen, failures, next_try)
       VALUES (?, ?, ?, 0, 0)
       ON CONFLICT(address) DO UPDATE SET
         node_id = COALESCE(excluded.node_id, known_peers.node_id),
         last_seen = excluded.last_seen,
         failures = 0,
         next_try = 0`,
      address,
      nodeId,
      Date.now(),
    );
  }

  peerFailed(address: string): void {
    const row = this.one<{ failures: number }>("SELECT failures FROM known_peers WHERE address = ?", address);
    const failures = Math.min((row?.failures ?? 0) + 1, 10);
    // 10s, 20s, 40s … capped at five minutes. A dead address is retried, never forgotten.
    const wait = Math.min(300_000, 10_000 * 2 ** Math.min(failures - 1, 6));
    this.run(
      "UPDATE known_peers SET failures = ?, next_try = ? WHERE address = ?",
      failures,
      Date.now() + wait,
      address,
    );
  }

  duePeers(now: number): KnownPeer[] {
    return this.all<Row>(
      "SELECT * FROM known_peers WHERE next_try <= ? ORDER BY last_seen DESC LIMIT 50",
      now,
    ).map(toKnownPeer);
  }

  forgetPeer(address: string): void {
    this.run("DELETE FROM known_peers WHERE address = ?", address);
  }

  // -------------------------------------------------------------- head pages

  /** Heads in author order, so two nodes can compare without one giant frame. */
  headsPage(cursor: string | null, limit = 500): LogHead[] {
    const size = Math.min(Math.max(limit, 1), 2000);
    return cursor
      ? this.all<LogHead>(
          "SELECT author, device, seq, id FROM chains WHERE author > ? ORDER BY author, device LIMIT ?",
          cursor,
          size,
        )
      : this.all<LogHead>("SELECT author, device, seq, id FROM chains ORDER BY author, device LIMIT ?", size);
  }

  /**
   * A head must be the end of an unbroken chain. If the database was restored
   * from a partial backup, walk back to the last contiguous seq so peers can
   * resend the hole instead of being told we already have it.
   */
  repairHeads(): { fixed: number } {
    let fixed = 0;
    const chains = this.all<{ author: string; device: string }>(
      "SELECT DISTINCT author, device FROM events",
    );
    for (const { author, device } of chains) {
      const seqs = this.all<{ seq: number }>(
        "SELECT seq FROM events WHERE author = ? AND device = ? ORDER BY seq ASC",
        author,
        device,
      ).map((row) => Number(row.seq));

      let last = -1;
      for (const seq of seqs) {
        if (seq !== last + 1) break;
        last = seq;
      }
      const head = this.head(author, device);
      if (last < 0) continue;
      if (!head || head.seq !== last) {
        const row = this.one<{ id: string }>(
          "SELECT id FROM events WHERE author = ? AND device = ? AND seq = ?",
          author,
          device,
          last,
        );
        if (row) {
          this.run(
            `INSERT INTO chains (author, device, seq, id) VALUES (?, ?, ?, ?)
             ON CONFLICT(author, device) DO UPDATE SET seq = excluded.seq, id = excluded.id`,
            author,
            device,
            last,
            row.id,
          );
          fixed++;
        }
      }
    }
    return { fixed };
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
      authors: one("SELECT COUNT(DISTINCT author) AS n FROM chains"),
      posts: one("SELECT COUNT(*) AS n FROM posts"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      follows: one("SELECT COUNT(*) AS n FROM follows WHERE active = 1"),
      retracted: one("SELECT COUNT(*) AS n FROM posts WHERE retracted_at IS NOT NULL"),
      reactions: one("SELECT COUNT(*) AS n FROM reactions"),
    };
  }

  eventsFor(author: string, limit = 200): Event[] {
    return this.all<Row>(
      "SELECT * FROM events WHERE author = ? AND device = '' ORDER BY seq DESC LIMIT ?",
      author,
      limit,
    ).map(toEvent);
  }

  eventsForChain(author: string, device: string, limit = 200): Event[] {
    return this.all<Row>(
      "SELECT * FROM events WHERE author = ? AND device = ? ORDER BY seq DESC LIMIT ?",
      author,
      device,
      limit,
    ).map(toEvent);
  }

  rangeEvents(author: string, device: string, from: number, to: number): Event[] {
    return this.all<Row>(
      "SELECT * FROM events WHERE author = ? AND device = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
      author,
      device,
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
   * Re-verify every chain from seq 0: hash chain, links, signatures, and that
   * any device that wrote was authorised to write.
   */
  async verifyAll(): Promise<VerifyReport> {
    const started = Date.now();
    const chains = this.all<{ author: string; device: string }>(
      "SELECT DISTINCT author, device FROM events ORDER BY author, device",
    );
    const errors: VerifyReport["errors"] = [];
    let total = 0;

    for (const { author, device } of chains) {
      const events = this.all<Row>(
        "SELECT * FROM events WHERE author = ? AND device = ? ORDER BY seq ASC",
        author,
        device,
      ).map(toEvent);
      total += events.length;
      errors.push(...(await verifyLog(events)));

      if (device && !this.deviceRegistered(author, device)) {
        errors.push({
          author,
          seq: events[0]?.seq ?? 0,
          code: "bad-signature",
          detail: "a device wrote without being authorised by its owner",
        });
      }
    }

    return {
      ok: errors.length === 0,
      authors: new Set(chains.map((chain) => chain.author)).size,
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
    const events = this.all<Row>(
      "SELECT * FROM events WHERE author = ? AND device = '' ORDER BY seq ASC",
      author,
    ).map(toEvent);

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
      this.db.exec("DELETE FROM posts; DELETE FROM profiles; DELETE FROM follows; DELETE FROM reactions; DELETE FROM deferred; DELETE FROM trail; DELETE FROM notifications; DELETE FROM devices;");
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
    device: String(row.device ?? ""),
    seq: Number(row.seq),
    prev: String(row.prev),
    kind: String(row.kind) as EventKind,
    body: JSON.parse(String(row.body)) as EventBody,
    createdAt: Number(row.created_at),
    sig: String(row.sig),
  };
}

function toCheckpoint(row: Row): Checkpoint & { sig: string } {
  return {
    author: String(row.author),
    device: String(row.device ?? ""),
    seq: Number(row.seq),
    root: String(row.root),
    count: Number(row.count),
    at: Number(row.at),
    sig: String(row.sig),
  };
}

function toNotificationView(row: Row): NotificationView {
  return {
    id: String(row.event_id),
    kind: String(row.kind) as NotificationView["kind"],
    actor: String(row.actor),
    postId: row.post_id ? String(row.post_id) : null,
    text: String(row.text ?? ""),
    createdAt: Number(row.created_at),
    seen: Boolean(row.seen),
  };
}

function toKnownPeer(row: Row): KnownPeer {
  return {
    address: String(row.address),
    nodeId: row.node_id ? String(row.node_id) : null,
    lastSeen: Number(row.last_seen),
    failures: Number(row.failures),
    nextTry: Number(row.next_try),
  };
}

export { ZERO_HASH, isBlobRef };
