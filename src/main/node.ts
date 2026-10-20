/**
 * RiverNode — one user's node.
 *
 * It owns a key, a log, a SQLite index, and a set of connections. It is the
 * whole server: there is nothing else to run, and nothing to shut down but
 * your own machine. Peers exchange only *missing* events, verified one by one,
 * and gossip them onward, so a post reaches people whose nodes never met the
 * author.
 *
 * Three things make it a network rather than a client:
 *   - it subscribes to the authors it cares about, so nobody has to exchange a
 *     head for every author in the world;
 *   - it signs Merkle checkpoints over its own chains, so a node that missed
 *     a year of a log can still prove what it holds;
 *   - it can run as a relay, holding other people's logs so they survive a
 *     machine being switched off.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { cleanText, createEvent, LIMITS } from "../core/events";
import { fromHex, toHex } from "../core/canonical";
import { checkpointPayload, merkleRoot, verifyMerkleProof, type Checkpoint } from "../core/merkle";
import { chunkBytes, joinChunks, verifyBlob, type BlobRef } from "../core/blobs";
import { sign, verify } from "../core/crypto";
import type {
  ChainHead,
  WireMessage,
} from "../core/wire";
import type {
  DeviceView,
  Event,
  EventBody,
  EventKind,
  PeerView,
  Snapshot,
  VerifyReport,
} from "../core/types";
import { loadOrCreateIdentity, type Identity, type KeyBox } from "./identity";
import { loadOrCreatePeerIdentity, type PeerIdentity } from "./peer-identity";
import { Store } from "./store";
import { PeerServer, type Connection, type DhtStatus } from "./transport";

export interface NodeOptions {
  dataDir: string;
  port?: number;
  discoveryPort?: number;
  discovery?: boolean;
  /** join the DHT and find peers across NATs */
  dht?: boolean;
  /** bootstrap nodes for the DHT; anyone can run one */
  dhtBootstrap?: string[];
  /** the topic to announce on */
  topic?: Uint8Array;
  peers?: string[];
  box?: KeyBox | null;
  /** hold other people's logs so they survive an offline author */
  relay?: boolean;
  log?: (line: string) => void;
}

interface Link {
  conn: Connection;
  nodeId: string | null;
  chains: Map<string, number>;
  openedAt: number;
}

const CHUNK = 120;
/** How many events of an unknown author's log we pull to learn who they are. */
const SAMPLE = 3;
/** How many authors a relay will hold the logs of. */
const RELAY_QUOTA = 2000;

export class RiverNode extends EventEmitter {
  readonly nodeId = randomBytes(8).toString("hex");
  store!: Store;
  identity!: Identity;
  peer!: PeerIdentity;
  server!: PeerServer;

  private links = new Map<string, Link>();
  private byNode = new Map<string, string>();
  private dialing = new Set<string>();
  private heartbeat: NodeJS.Timeout | null = null;
  private gossipTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private started = false;
  private relay: boolean;

  constructor(private readonly options: NodeOptions) {
    super();
    this.relay = options.relay ?? false;
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  // -------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.identity = await loadOrCreateIdentity(this.options.dataDir, this.options.box ?? null);
    this.peer = await loadOrCreatePeerIdentity(this.options.dataDir, this.options.box ?? null);
    this.store = new Store(join(this.options.dataDir, "river.db"));

    this.server = new PeerServer({
      peer: this.peer,
      port: this.options.port ?? 0,
      discoveryPort: this.options.discoveryPort ?? 7332,
      discovery: this.options.discovery ?? true,
      dht: this.options.dht ?? false,
      dhtBootstrap: this.options.dhtBootstrap ?? [],
      topic: this.options.topic ?? defaultTopic(),
      chains: () => this.chainHeads(),
      log: (line) => this.log(line),
    });

    this.server.on("connection", (connection) => this.onConnection(connection));
    this.server.on("message", (connection, message) => {
      void this.onMessage(connection, message).catch((error) => {
        this.log(`message failed: ${(error as Error).message}`);
      });
    });
    this.server.on("close", (connection) => this.onClose(connection));
    this.server.on("auth", (connection, chains) => this.onAuth(connection, chains));
    this.server.on("discovered", (address, peerKey) => this.onDiscovered(address, peerKey));
    this.server.on("dht-peer", (transport) => {
      this.log(`dht: peer ${transport.slice(0, 8)}`);
      this.emit("update", "peers");
    });

    await this.server.listen();
    this.started = true;
    this.log(
      `node ${this.nodeId} listening on ${this.server.address()} · author ${this.identity.publicKey.slice(0, 12)}… · peer ${this.peer.publicKey.slice(0, 8)}…`,
    );

    for (const address of this.options.peers ?? []) {
      void this.dial(address);
    }

    this.heartbeat = setInterval(() => this.broadcastHave(), 15_000);
    this.checkpointTimer = setInterval(() => void this.publishCheckpoint(), 60_000);
    this.emit("ready");
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.gossipTimer) clearTimeout(this.gossipTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.server?.stop();
    this.store?.close();
    this.started = false;
  }

  get running(): boolean {
    return this.started;
  }

  dhtStatus(): DhtStatus {
    return this.server.dhtStatus();
  }

  // -------------------------------------------------------------- publishing

  /** Sign a new event onto the end of our own log. */
  async publish(kind: EventKind, input: EventBody, device = ""): Promise<Event> {
    const body = normaliseBody(kind, input);
    const slot = this.store.nextSlot(this.identity.publicKey, device);
    const event = await createEvent(this.identity.privateKey, {
      author: this.identity.publicKey,
      device: device || undefined,
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

  /** Authorise a new device key to write for this identity. */
  async authoriseDevice(devicePublicKey: string, name = ""): Promise<Event> {
    return this.publish("device", { device: devicePublicKey, name });
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
      this.store.peerFailed(address);
      throw error;
    } finally {
      this.dialing.delete(address);
    }
  }

  private onDiscovered(address: string, peerKey: string | null) {
    if (peerKey && this.store.knownPeers().some((peer) => peer.nodeId === peerKey)) return;
    void this.maybeDial(address);
  }

  private async maybeDial(address: string) {
    if (this.byNode.size > 0) return;
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
      chains: new Map(),
      openedAt: Date.now(),
    };
    this.links.set(connection.id, link);
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

  /** The peer proved which key it holds. Now we can talk. */
  private onAuth(connection: Connection, chains: ChainHead[]) {
    const link = this.links.get(connection.id);
    if (!link) return;
    link.nodeId = connection.peer;
    this.byNode.set(connection.peer ?? connection.id, connection.id);
    this.store.rememberPeer(connection.address, connection.peer);
    this.log(`peer ${connection.peer?.slice(0, 8)} connected (${connection.direction}) at ${connection.address}`);

    // Tell them what we have, and what we want to hear.
    connection.send({ t: "have", chains: this.chainHeads() });
    connection.send({ t: "subs", authors: this.subscriptions() });
    this.emit("update", "peers");

    for (const [author, device, seq] of chains) {
      this.noteHead(author, device, seq);
    }
  }

  private async onMessage(connection: Connection, message: WireMessage) {
    const link = this.links.get(connection.id);
    if (!link) return;

    switch (message.t) {
      case "have": {
        for (const [author, device, seq] of message.chains) {
          this.noteHead(author, device, seq);
        }
        break;
      }

      case "subs": {
        // They want these authors. If we hold them, say so.
        const heads = this.chainHeads().filter(([author]) => message.authors.includes(author));
        if (heads.length > 0) connection.send({ t: "have", chains: heads });
        break;
      }

      case "want": {
        for (const [author, device, from, to] of message.ranges) {
          let cursor = Math.max(0, Math.floor(from));
          const last = Math.min(Math.floor(to), cursor + CHUNK - 1);
          while (cursor <= last) {
            const events = this.store.rangeEvents(author, device, cursor, last);
            if (events.length === 0) break;
            connection.send({ t: "events", events });
            cursor += events.length;
            if (cursor <= last) break; // the peer asks again on the next `have`
          }
        }
        break;
      }

      case "events": {
        let added = 0;
        const gaps = new Set<string>();
        for (const raw of message.events) {
          const event = raw as Event;
          const result = await this.store.ingest(event);
          if (result.status === "added") added++;
          else if (result.status === "gap") gaps.add(`${event.author}|${event.device ?? ""}`);
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
        for (const key of gaps) {
          const [author, device] = key.split("|");
          this.requestChain(connection, author, device ?? "");
        }
        break;
      }

      case "checkpoint": {
        await this.onCheckpoint(connection, message);
        break;
      }

      case "proof": {
        const valid = await verifyMerkleProof(message.leaf, {
          root: message.root,
          index: message.index,
          size: message.size,
          path: message.path,
          leaf: message.leaf,
        });
        if (valid) {
          // The proof says the event is in that log. Pull the log and check.
          this.noteHead(message.author, message.device, message.seq);
          this.requestChain(connection, message.author, message.device);
        }
        break;
      }

      case "blob-want": {
        await this.serveBlob(connection, message.hash);
        break;
      }

      case "blob-chunk": {
        await this.receiveBlobChunk(message);
        break;
      }

      case "ping": {
        connection.send({ t: "pong", at: message.at });
        break;
      }

      case "pong":
        break;

      case "bye":
        connection.close();
        break;
    }
  }

  // ------------------------------------------------------------------ heads

  private chainHeads(): ChainHead[] {
    return this.store.heads().map((head) => [head.author, head.device, head.seq]);
  }

  /** The authors this node wants to hear about. */
  private subscriptions(): string[] {
    const stored = this.store.subscriptions();
    if (stored.length > 0) return stored;

    // Nothing stored yet: fall back to who we follow and who wrote to us.
    const authors = new Set<string>();
    for (const author of this.store.following(this.identity.publicKey)) authors.add(author);
    for (const author of this.store.followers(this.identity.publicKey)) authors.add(author);
    for (const event of this.store.recentEvents(200)) {
      if (event.author !== this.identity.publicKey) authors.add(event.author);
    }
    authors.add(this.identity.publicKey);
    return [...authors];
  }

  /** Refresh the subscription set from the follow graph. */
  refreshSubscriptions(): void {
    const authors = new Set<string>([this.identity.publicKey]);
    for (const author of this.store.following(this.identity.publicKey)) authors.add(author);
    for (const author of this.store.followers(this.identity.publicKey)) authors.add(author);
    for (const event of this.store.recentEvents(200)) {
      if (event.author !== this.identity.publicKey) authors.add(event.author);
    }
    this.store.setSubscriptions([...authors]);
  }

  /**
   * A peer told us where a chain has reached. Ask for what we are missing —
   * but only a sample of a chain we have never seen, so a node does not pull
   * the whole history of every stranger on the network.
   */
  private noteHead(author: string, device: string, seq: number): void {
    const head = this.store.head(author, device);
    const wanted = this.store.wanted().find((entry) => entry.author === author && entry.device === device);

    if (head && head.seq >= seq) return;

    // A relay keeps a bounded number of logs, so one busy author cannot fill
    // the disk of a volunteer machine.
    if (this.relay && !head && !wanted) {
      const mirrored = this.store.heads().filter((entry) => entry.author !== this.identity.publicKey).length;
      if (mirrored >= RELAY_QUOTA) return;
    }

    this.store.wantChain(author, device, seq);

    for (const link of this.links.values()) {
      this.requestChain(link.conn, author, device, head ? head.seq + 1 : 0, seq);
    }
  }

  private requestChain(
    connection: Connection,
    author: string,
    device: string,
    from?: number,
    to?: number,
  ): void {
    const head = this.store.head(author, device);
    const start = from ?? (head ? head.seq + 1 : 0);
    const end = to ?? (this.store.wanted().find((e) => e.author === author && e.device === device)?.seq ?? start);
    if (end < start) return;

    // A relay mirrors whole logs, so an author can go offline without their
    // history going with them. A reader takes a sample of a stranger's log,
    // so nobody pulls the whole internet to find out who exists.
    const sampleEnd = this.relay || head ? end : Math.max(start, end - SAMPLE);
    connection.send({ t: "want", ranges: [[author, device, start, Math.max(start, sampleEnd)]] });
  }

  // ------------------------------------------------------------- checkpoints

  /** Sign a Merkle root over our own chain and tell the network about it. */
  async publishCheckpoint(): Promise<Checkpoint | null> {
    const head = this.store.head(this.identity.publicKey, "");
    if (!head) return null;
    const ids = this.store.chainIds(this.identity.publicKey, "");
    if (ids.length === 0) return null;
    const root = await merkleRoot(ids);
    const checkpoint: Checkpoint = {
      author: this.identity.publicKey,
      device: "",
      seq: head.seq,
      root,
      count: ids.length,
      at: Date.now(),
    };
    const sig = await sign(this.identity.privateKey, new TextEncoder().encode(checkpointPayload(checkpoint)));
    this.store.saveCheckpoint(checkpoint, sig);
    this.broadcast({ t: "checkpoint", ...checkpoint, sig });
    return checkpoint;
  }

  private async onCheckpoint(
    connection: Connection,
    message: {
      author: string;
      device: string;
      seq: number;
      root: string;
      count: number;
      at: number;
      sig: string;
    },
  ): Promise<void> {
    const checkpoint: Checkpoint = {
      author: message.author,
      device: message.device,
      seq: message.seq,
      root: message.root,
      count: message.count,
      at: message.at,
    };
    const ok = await verify(message.author, new TextEncoder().encode(checkpointPayload(checkpoint)), message.sig);
    if (!ok) {
      this.log("rejected a checkpoint: the signature does not cover it");
      return;
    }
    this.store.saveCheckpoint(checkpoint, message.sig);
    this.emit("update", "checkpoints");

    // If we are behind that root, we want the events it covers.
    const head = this.store.head(message.author, message.device);
    if (!head || head.seq < message.seq) {
      this.noteHead(message.author, message.device, message.seq);
    }
  }

  // ------------------------------------------------------------------ blobs

  private async serveBlob(connection: Connection, hash: string): Promise<void> {
    const blob = this.store.getBlob(hash);
    if (!blob) return;
    const chunks = chunkBytes(blob.bytes);
    for (const [index, chunk] of chunks.entries()) {
      connection.send({
        t: "blob-chunk",
        hash,
        index,
        total: chunks.length,
        data: toHex(chunk),
      });
    }
  }

  private pendingBlobs = new Map<string, Uint8Array[]>();

  private async receiveBlobChunk(message: {
    hash: string;
    index: number;
    total: number;
    data: string;
  }): Promise<void> {
    const parts = this.pendingBlobs.get(message.hash) ?? [];
    parts[message.index] = fromHex(message.data);
    this.pendingBlobs.set(message.hash, parts);

    if (parts.filter(Boolean).length < message.total) return;
    this.pendingBlobs.delete(message.hash);

    const bytes = joinChunks(parts);
    if (!(await verifyBlob(message.hash, bytes))) {
      this.log(`rejected a blob: its bytes do not match ${message.hash.slice(0, 8)}`);
      return;
    }
    const ref: BlobRef = { hash: message.hash, size: bytes.length, type: "application/octet-stream" };
    this.store.putBlob(ref, bytes);
    this.emit("update", "blobs");
  }

  // ----------------------------------------------------------------- gossip

  private broadcastHave() {
    if (!this.started) return;
    this.broadcast({ t: "have", chains: this.chainHeads() });
  }

  private broadcast(message: WireMessage, exceptId?: string) {
    this.server.broadcast(message, exceptId);
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
        heads: link.chains.size,
      }))
      .sort((a, b) => a.since - b.since);
  }

  devices(): DeviceView[] {
    return this.store.devicesFor(this.identity.publicKey);
  }

  snapshot(includeSilt = false): Snapshot {
    const pubkey = this.identity.publicKey;
    const meProfile = this.store.profile(pubkey);
    const head = this.store.head(pubkey, "");
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
      notifications: this.store.notifications(pubkey),
      unread: this.store.unread(pubkey),
      muted: this.store.muted(),
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

/** The topic every River node shares. Sharded by interest in a later version. */
export function defaultTopic(): Uint8Array {
  const topic = new Uint8Array(32);
  const bytes = new TextEncoder().encode("river-v1");
  topic.set(bytes.slice(0, 32));
  return topic;
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

export { toHex };
