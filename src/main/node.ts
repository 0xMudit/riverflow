/**
 * RiverNode — one user's node.
 *
 * It owns a key, a log, a SQLite index, and a few TCP connections. It is the
 * whole server: there is nothing else to run, and nothing to shut down but your
 * own machine. Peers exchange only *missing* events, verified one by one, and
 * gossip them onward, so a post reaches people whose nodes never met the author.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { cleanText, createEvent, LIMITS } from "../core/events";
import type {
  Event,
  EventBody,
  EventKind,
  PeerView,
  Snapshot,
  VerifyReport,
} from "../core/types";
import { loadOrCreateIdentity, type Identity, type KeyBox } from "./identity";
import { Store } from "./store";
import { PeerServer, type Connection, type WireMessage } from "./transport";

export interface NodeOptions {
  dataDir: string;
  port?: number;
  discoveryPort?: number;
  discovery?: boolean;
  peers?: string[];
  box?: KeyBox | null;
  log?: (line: string) => void;
}

interface Link {
  conn: Connection;
  nodeId: string | null;
  heads: Map<string, number>;
  openedAt: number;
}

const HELLO_TIMEOUT = 10_000;
const CHUNK = 120;

export class RiverNode extends EventEmitter {
  readonly nodeId = randomBytes(8).toString("hex");
  store!: Store;
  identity!: Identity;
  server!: PeerServer;

  private links = new Map<string, Link>();
  private byNode = new Map<string, string>();
  private dialing = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private gossipTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly options: NodeOptions) {
    super();
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  // -------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.identity = await loadOrCreateIdentity(this.options.dataDir, this.options.box ?? null);
    this.store = new Store(join(this.options.dataDir, "river.db"));

    this.server = new PeerServer({
      nodeId: this.nodeId,
      port: this.options.port ?? 0,
      discoveryPort: this.options.discoveryPort ?? 7332,
      discovery: this.options.discovery ?? true,
    });

    this.server.on("connection", (connection) => this.onConnection(connection));
    this.server.on("message", (connection, message) => {
      void this.onMessage(connection, message).catch((error) => {
        this.log(`message failed: ${(error as Error).message}`);
      });
    });
    this.server.on("close", (connection) => this.onClose(connection));
    this.server.on("discovered", (address: string, nodeId: string) => {
      void this.maybeDial(address, nodeId);
    });

    await this.server.listen();
    this.started = true;
    this.log(
      `node ${this.nodeId} listening on ${this.server.address()} · author ${this.identity.publicKey.slice(0, 12)}…`,
    );

    for (const address of this.options.peers ?? []) {
      void this.dial(address);
    }

    this.heartbeat = setInterval(() => this.broadcastHave(), 15_000);
    this.emit("ready");
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.gossipTimer) clearTimeout(this.gossipTimer);
    this.server?.stop();
    this.store?.close();
    this.started = false;
  }

  get running(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------- publishing

  /** Sign a new event onto the end of our own log. */
  async publish(kind: EventKind, input: EventBody): Promise<Event> {
    const body = normaliseBody(kind, input);
    const slot = this.store.nextSlot(this.identity.publicKey);
    const event = await createEvent(this.identity.privateKey, {
      author: this.identity.publicKey,
      seq: slot.seq,
      prev: slot.prev,
      kind,
      body,
    });

    const result = await this.store.ingest(event);
    if (result.status !== "added") {
      throw new Error(result.reason ?? `could not append event (${result.status})`);
    }

    this.broadcastHave();
    this.emit("update", "local");
    return event;
  }

  // ------------------------------------------------------------------- peers

  async dial(address: string): Promise<void> {
    if (this.dialing.has(address)) return;
    this.dialing.add(address);
    try {
      await this.server.dial(address);
      this.log(`dialled ${address}`);
    } catch (error) {
      this.log(`could not reach ${address}: ${(error as Error).message}`);
      throw error;
    } finally {
      this.dialing.delete(address);
    }
  }

  private async maybeDial(address: string, nodeId: string) {
    if (this.byNode.has(nodeId) || this.dialing.has(address)) return;
    try {
      await this.dial(address);
    } catch {
      /* the other node may have gone; discovery will try again */
    }
  }

  private onConnection(connection: Connection) {
    const link: Link = {
      conn: connection,
      nodeId: null,
      heads: new Map(),
      openedAt: Date.now(),
    };
    this.links.set(connection.id, link);
    connection.send({
      t: "hello",
      v: 1,
      nodeId: this.nodeId,
      port: this.server.listenPort,
      heads: this.headPairs(),
    });

    setTimeout(() => {
      if (!link.nodeId && this.links.has(connection.id)) {
        this.log(`dropping ${connection.address}: no hello`);
        connection.close();
      }
    }, HELLO_TIMEOUT).unref?.();
  }

  private onClose(connection: Connection) {
    const link = this.links.get(connection.id);
    if (!link) return;
    this.links.delete(connection.id);
    if (link.nodeId && this.byNode.get(link.nodeId) === connection.id) {
      this.byNode.delete(link.nodeId);
      this.log(`lost peer ${link.nodeId}`);
      this.emit("update", "peers");
    }
  }

  private async onMessage(connection: Connection, message: WireMessage) {
    const link = this.links.get(connection.id);
    if (!link) return;

    switch (message.t) {
      case "hello": {
        if (message.nodeId === this.nodeId) {
          connection.close();
          return;
        }
        const existingId = this.byNode.get(message.nodeId);
        if (existingId && existingId !== connection.id) {
          // Both sides dialled at once. The lower node id keeps its outgoing
          // connection; the higher one keeps the incoming. Exactly one survives.
          const keepOutgoing = this.nodeId < message.nodeId;
          const newIsOutgoing = connection.direction === "out";
          if (keepOutgoing === newIsOutgoing) {
            this.server.close(existingId);
          } else {
            connection.close();
            return;
          }
        }

        link.nodeId = message.nodeId;
        link.heads = new Map(message.heads);
        this.byNode.set(message.nodeId, connection.id);
        this.log(`peer ${message.nodeId} connected (${connection.direction}) at ${connection.address}`);
        this.emit("update", "peers");
        this.requestMissing(link);
        break;
      }

      case "have": {
        for (const [author, seq] of message.heads) {
          const known = link.heads.get(author) ?? -1;
          if (seq > known) link.heads.set(author, seq);
        }
        this.requestMissing(link);
        break;
      }

      case "want": {
        for (const [author, from, to] of message.ranges) {
          let cursor = Math.max(0, Math.floor(from));
          const last = Math.min(Math.floor(to), cursor + CHUNK - 1);
          while (cursor <= last) {
            const events = this.store.rangeEvents(author, cursor, last);
            if (events.length === 0) break;
            connection.send({ t: "events", events });
            cursor += events.length;
            if (cursor <= last) break; // peer asks again on the next `have`
          }
        }
        break;
      }

      case "events": {
        let added = 0;
        const gaps = new Set<string>();
        for (const raw of message.events) {
          const result = await this.store.ingest(raw as Event);
          if (result.status === "added") added++;
          else if (result.status === "gap") gaps.add((raw as Event).author);
          else if (result.status === "invalid") {
            this.log(`rejected an event: ${result.reason}`);
          }
        }
        if (added > 0) {
          this.log(`accepted ${added} event(s) from ${link.nodeId ?? connection.address}`);
          this.emit("update", "remote");
          // Gossip onward: this is what makes it a network rather than a client.
          this.scheduleGossip();
        }
        if (gaps.size > 0) {
          this.requestMissing(link, gaps);
        }
        break;
      }

      case "bye":
        connection.close();
        break;
    }
  }

  private requestMissing(link: Link, authors?: Set<string>) {
    const ranges: Array<[string, number, number]> = [];
    for (const [author, seq] of link.heads) {
      if (authors && !authors.has(author)) continue;
      const head = this.store.head(author);
      const from = head ? head.seq + 1 : 0;
      if (seq >= from) ranges.push([author, from, seq]);
      if (ranges.length >= 100) break;
    }
    if (ranges.length > 0) {
      link.conn.send({ t: "want", ranges });
    }
  }

  private headPairs(): Array<[string, number]> {
    return this.store.heads().map((head) => [head.author, head.seq]);
  }

  private broadcastHave() {
    if (!this.started) return;
    this.server.broadcast({ t: "have", heads: this.headPairs() });
  }

  private scheduleGossip() {
    if (this.gossipTimer) return;
    this.gossipTimer = setTimeout(() => {
      this.gossipTimer = null;
      this.broadcastHave();
    }, 180);
  }

  // ------------------------------------------------------------------ views

  peerViews(): PeerView[] {
    return [...this.links.values()]
      .filter((link) => link.nodeId)
      .map((link) => ({
        id: link.nodeId as string,
        address: link.conn.address,
        direction: link.conn.direction,
        since: link.openedAt,
        lastSeen: link.conn.lastSeen,
        heads: link.heads.size,
      }))
      .sort((a, b) => a.since - b.since);
  }

  snapshot(includeSilt = false): Snapshot {
    const pubkey = this.identity.publicKey;
    const meProfile = this.store.profile(pubkey);
    const head = this.store.head(pubkey);
    const feed = this.store.feed({ includeSilt, viewer: pubkey });

    const authors = new Set<string>([pubkey]);
    for (const post of [...feed.top, ...feed.replies]) authors.add(post.author);
    for (const target of this.store.following(pubkey)) authors.add(target);

    return {
      me: {
        pubkey,
        seq: head?.seq ?? -1,
        name: meProfile?.name ?? "unnamed",
        bio: meProfile?.bio ?? "",
        hue: meProfile?.hue ?? 200,
      },
      posts: feed.top,
      replies: feed.replies,
      profiles: this.store.profilesFor([...authors]),
      following: this.store.following(pubkey),
      followers: this.store.followers(pubkey),
      peers: this.peerViews(),
      listen: this.server.address(),
      stats: this.store.stats(),
      includeSilt,
    };
  }

  authorLog(author: string, limit = 120): Event[] {
    return this.store.eventsFor(author, limit);
  }

  authorPosts(author: string): ReturnType<Store["postsByAuthor"]> {
    return this.store.postsByAuthor(author);
  }

  verify(): Promise<VerifyReport> {
    return this.store.verifyAll();
  }
}

function normaliseBody(kind: EventKind, body: EventBody): EventBody {
  const out: EventBody = { ...body };
  if (out.text !== undefined) {
    out.text = cleanText(out.text);
    if (!out.text) throw new Error("that post is empty");
    if (out.text.length > LIMITS.text) throw new Error(`posts are limited to ${LIMITS.text} characters`);
  }
  if (out.name !== undefined) out.name = cleanText(out.name).slice(0, LIMITS.name);
  if (out.bio !== undefined) out.bio = cleanText(out.bio).slice(0, LIMITS.bio);
  if (out.reason !== undefined) out.reason = cleanText(out.reason).slice(0, LIMITS.reason);
  if (kind === "post" && !out.text) throw new Error("a post needs text");
  if (kind === "profile" && !out.name) throw new Error("a profile needs a name");
  return out;
}
