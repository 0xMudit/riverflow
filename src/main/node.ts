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

import { cleanText, createEvent, eventId, LIMITS } from "../core/events";
import { formatSiwe, signatureBytes, verifySiwe } from "../core/eth";
import { fromHex, toHex } from "../core/canonical";
import { checkpointPayload, merkleRoot, verifyMerkleProof, type Checkpoint } from "../core/merkle";
import { chunkBytes, joinChunks, verifyBlob, blobHash, BlobTransfer, BLOB_MAX_BYTES, type BlobRef } from "../core/blobs";
import { sign, verify } from "../core/crypto";
import type {
  ChainHead,
  WireMessage,
} from "../core/wire";
import type {
  DeviceView,
  Event,
  EventBody,
  EventDraftView,
  EventKind,
  EventScheme,
  PeerView,
  Snapshot,
  VerifyReport,
} from "../core/types";
import { loadOrCreateIdentity, type Identity, type KeyBox } from "./identity";
import { loadOrCreatePeerIdentity, type PeerIdentity } from "./peer-identity";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "./device-identity";
import { loadOrCreateDataKey } from "./data-key";
import { globalTopic, shardTopics } from "../core/topics";
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
/** How long a want for a chain nobody has answered stays on the books. */
const WANT_TTL_MS = 10 * 60 * 1000;
/** How long a request is left alone before the chain is asked for again. */
const WANT_RETRY_MS = 5_000;
/** How many authors a relay will hold the logs of. */
const RELAY_QUOTA = 2000;

export class RiverNode extends EventEmitter {
  readonly nodeId = randomBytes(8).toString("hex");
  store!: Store;
  identity!: Identity;
  peer!: PeerIdentity;
  device!: DeviceIdentity;
  server!: PeerServer;

  private links = new Map<string, Link>();
  private byNode = new Map<string, string>();
  private dialing = new Set<string>();
  /** checkpoints we were told about, waiting for a proof that they are real */
  private pendingProofs = new Map<string, string>();
  /** the wallet this machine is using, and whether it has signed in */
  private wallet: { address: string; signedIn: boolean } | null = null;
  /** the one sign-in challenge that is outstanding */
  private challenge: string | null = null;
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
    this.device = await loadOrCreateDeviceIdentity(this.options.dataDir, this.options.box ?? null);
    // Everything the node keeps is sealed with a key the keychain holds. The
    // words are not readable on the disk, only on this machine, by this user.
    const dataKey = await loadOrCreateDataKey(this.options.dataDir, this.options.box ?? null);
    this.store = new Store(join(this.options.dataDir, "river.db"), { dataKey });

    this.server = new PeerServer({
      peer: this.peer,
      port: this.options.port ?? 0,
      discoveryPort: this.options.discoveryPort ?? 7332,
      discovery: this.options.discovery ?? true,
      dht: this.options.dht ?? false,
      dhtBootstrap: this.options.dhtBootstrap ?? [],
      topics: await this.topics(),
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

    // Know who to listen for from the first second, and give the network a
    // signed root over our own chain straight away.
    this.refreshSubscriptions();
    void this.publishCheckpoint();

    this.heartbeat = setInterval(() => this.broadcastHave(), 15_000);
    this.checkpointTimer = setInterval(() => void this.publishCheckpoint(), 60_000);
    this.emit("ready");
  }

  async stop(): Promise<void> {
    // Flip first: anything mid-flight (publishCheckpoint awaits merkleRoot)
    // checks `started` after its awaits and backs off instead of writing to a
    // closed database.
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.gossipTimer) clearTimeout(this.gossipTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.server?.stop();
    this.store?.close();
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
    // A device signs for the person, with its own key.
    const signingKey =
      device && device === this.device.publicKey ? this.device.privateKey : this.identity.privateKey;
    const event = await createEvent(signingKey, {
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

  /**
   * A draft for somebody else to sign.
   *
   * The node knows where in the chain an event belongs and what its id will
   * be, but it does not hold the key: a wallet does. So the node hands back
   * the draft, the person signs it in their wallet, and the signed event comes
   * back to be checked and filed.
   */
  async draftEvent(
    kind: EventKind,
    input: EventBody,
    options: { author?: string; scheme?: EventScheme } = {},
  ): Promise<EventDraftView> {
    const body = normaliseBody(kind, input);
    const author = options.author ?? this.wallet?.address ?? this.identity.publicKey;
    const scheme = options.scheme ?? (author === this.identity.publicKey ? "ed25519" : "eth");
    const slot = this.store.nextSlot(author, "");
    const createdAt = Date.now();
    const id = await eventId({
      author,
      scheme: scheme === "ed25519" ? undefined : scheme,
      seq: slot.seq,
      prev: slot.prev,
      kind,
      body,
      createdAt,
    });
    return {
      author,
      scheme,
      seq: slot.seq,
      prev: slot.prev,
      kind,
      body,
      createdAt,
      id,
      /** the bytes to sign */
      digest: id,
      signing: scheme === "eth" ? "personal_sign" : "ed25519",
    };
  }

  /** Take an event somebody else signed, check it, and file it. */
  async submitEvent(event: Event): Promise<Event> {
    const result = await this.store.ingest(event);
    if (result.status !== "added") {
      throw new Error(result.reason ?? `could not append event (${result.status})`);
    }
    this.broadcastHave();
    this.emit("update", "local");
    return event;
  }

  // ------------------------------------------------------------------ wallets

  /** Remember the wallet this machine is using, if any. */
  setWallet(address: string | null): void {
    if (!address) {
      this.wallet = null;
      this.emit("update", "wallet");
      return;
    }
    this.wallet = { address: address.toLowerCase(), signedIn: false };
    this.emit("update", "wallet");
  }

  walletInfo(): { address: string; signedIn: boolean } | null {
    return this.wallet ? { ...this.wallet } : null;
  }

  /** A sign-in challenge: a statement the wallet can sign, once. */
  createChallenge(): { message: string; nonce: string } {
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
    this.challenge = nonce;
    return {
      nonce,
      message: formatSiwe({
        domain: "river",
        address: this.wallet?.address ?? "",
        statement: "Sign in to River. This proves the wallet is yours.",
        uri: "river://signin",
        nonce,
      }),
    };
  }

  /** Check the signature that came back with a challenge. */
  async verifySignIn(message: string, signatureHex: string): Promise<boolean> {
    const result = verifySiwe(message, signatureBytes(signatureHex));
    if (!result) return false;
    if (!this.challenge || result.nonce !== this.challenge) return false;
    if (!this.wallet || result.address !== this.wallet.address) {
      this.wallet = { address: result.address, signedIn: true };
    } else {
      this.wallet.signedIn = true;
    }
    this.challenge = null;
    this.emit("update", "wallet");
    return true;
  }

  /** Authorise a new device key to write for this identity. */
  async authoriseDevice(devicePublicKey: string, name = ""): Promise<Event> {
    return this.publish("device", { device: devicePublicKey, name });
  }

  /** Authorise this machine's own device key, so it can write on its own chain. */
  async authoriseThisDevice(name = "this machine"): Promise<Event> {
    return this.authoriseDevice(this.device.publicKey, name);
  }

  /** Withdraw a device's authority. Its past stays; its future stops. */
  async revokeDevice(devicePublicKey: string): Promise<Event> {
    return this.publish("device", { device: devicePublicKey, revoked: true, name: "" });
  }

  /**
   * Take in media. The bytes are checked against their hash before they are
   * kept, and stored under that hash: one copy serves every follower.
   */
  async attachMedia(
    bytes: Uint8Array,
    type: string,
    dimensions: { width?: number; height?: number } = {},
  ): Promise<BlobRef> {
    if (bytes.length > BLOB_MAX_BYTES) {
      throw new Error(`media is limited to ${Math.round(BLOB_MAX_BYTES / 1024 / 1024)} MB`);
    }
    const hash = await blobHash(bytes);
    const ref: BlobRef = {
      hash,
      size: bytes.length,
      type: type || "application/octet-stream",
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
    };
    this.store.putBlob(ref, bytes);
    this.emit("update", "blobs");
    return ref;
  }

  /** The topics this node announces on: the global one, plus its shards. */
  private async topics(): Promise<Uint8Array[]> {
    const base = this.options.topic ?? globalTopic();
    const authors = this.store.following(this.identity.publicKey);
    const shards = await shardTopics(authors);
    return [base, ...shards];
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
        const touched = new Set<string>();
        for (const raw of message.events) {
          const event = raw as Event;
          const result = await this.store.ingest(event);
          if (result.status === "added") added++;
          else if (result.status === "invalid") {
            this.log(`rejected an event: ${result.reason}`);
          }
          touched.add(`${event.author}|${event.device ?? ""}`);
        }
        if (added > 0) {
          this.log(`accepted ${added} event(s) from ${link.nodeId ?? connection.address}`);
          this.emit("update", "remote");
          // Gossip onward: this is what makes it a network rather than a client.
          this.scheduleGossip();
        }
        // A chain that has arrived in full is no longer wanted.
        this.reconcileWants();
        // A peer sends what we asked for, which is often only the beginning of
        // a chain. Ask for the rest now, rather than waiting for the next
        // heartbeat to find out what is still missing.
        for (const key of touched) {
          const [author, device] = key.split("|");
          this.requestRest(connection, author, device ?? "");
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
        const key = `${message.author}|${message.device}`;
        const expected = this.pendingProofs.get(key);
        // The proof must check out against the root we were given, if we have
        // one: a proof of anything else is a proof of nothing.
        if (valid && (expected === undefined || expected === message.root)) {
          this.pendingProofs.delete(key);
          // The proof says the event is in that log. Pull the log and check.
          this.noteHead(message.author, message.device, message.seq);
          this.requestChain(connection, message.author, message.device);
        }
        break;
      }

      case "proof-want": {
        // Somebody wants to know that an event is in a log we hold. Prove it.
        const proof = await this.store.proofFor(message.author, message.device, message.seq);
        if (!proof) break;
        connection.send({
          t: "proof",
          author: message.author,
          device: message.device,
          seq: message.seq,
          leaf: proof.leaf,
          root: proof.root,
          index: proof.index,
          size: proof.size,
          path: proof.path,
        });
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
   * Do we want the whole of this person's log, or only a sample of it?
   *
   * The people you follow, and the people who follow you, you want all of.
   * A stranger you have never heard of, you want enough to know who they are:
   * nobody pulls the whole internet to find out who exists.
   */
  private interestedIn(author: string): boolean {
    if (author === this.identity.publicKey) return true;
    // A relay mirrors other people's logs so they survive an offline author.
    if (this.relay) return true;
    if (this.store.following(this.identity.publicKey).includes(author)) return true;
    if (this.store.followers(this.identity.publicKey).includes(author)) return true;
    return this.store.subscriptions().includes(author);
  }

  /**
   * A peer told us where a chain has reached. Ask for what we are missing —
   * but only a sample of a chain we have never seen, so a node does not pull
   * the whole history of every stranger on the network.
   */
  private noteHead(author: string, device: string, seq: number): void {
    const head = this.store.head(author, device);
    const wanted = this.store.wantFor(author, device);

    if (head && head.seq >= seq) return;

    // A request for this chain is already outstanding. Asking again would
    // make the peer send the same events a second time.
    if (wanted && wanted.seq >= seq && Date.now() - wanted.at < WANT_RETRY_MS) return;

    // A relay keeps a bounded number of logs, so one busy author cannot fill
    // the disk of a volunteer machine.
    if (this.relay && !head && !wanted) {
      const mirrored = this.store.heads().filter((entry) => entry.author !== this.identity.publicKey).length;
      if (mirrored >= RELAY_QUOTA) return;
    }

    const interested = this.interestedIn(author);
    if (interested) {
      // A want means "we want this chain up to here". It is what tells us to
      // ask for the rest of it once the first part has landed.
      this.store.wantChain(author, device, seq);
    } else {
      this.store.clearWant(author, device);
    }

    for (const link of this.links.values()) {
      this.requestChain(
        link.conn,
        author,
        device,
        head ? head.seq + 1 : 0,
        seq,
        !interested,
      );
    }
  }

  private requestChain(
    connection: Connection,
    author: string,
    device: string,
    from?: number,
    to?: number,
    sample = false,
  ): void {
    const head = this.store.head(author, device);
    const start = from ?? (head ? head.seq + 1 : 0);
    const end = to ?? (this.store.wantFor(author, device)?.seq ?? start);
    if (end < start) return;

    // A reader takes a sample of a stranger's log: the first few events, which
    // is enough to know who they are, and not the whole history of everybody.
    const last = sample ? Math.min(end, start + SAMPLE - 1) : end;
    connection.send({ t: "want", ranges: [[author, device, start, last]] });
  }

  /**
   * Forget the chains we have now.
   *
   * A want means "a peer told us about a chain we do not hold". Once the chain
   * has arrived in full the want is spent, and a want that nobody answers must
   * not be kept for ever.
   */
  private reconcileWants(): void {
    this.store.clearSatisfiedWants();
    this.store.expireWants(WANT_TTL_MS);
  }

  /**
   * Ask for what is still missing of a chain we have only had a part of.
   *
   * A peer sends what we asked for. When that was only the opening of a
   * chain, the rest has to be asked for again — otherwise the node waits for
   * the next heartbeat to learn that it is still behind.
   */
  private requestRest(connection: Connection, author: string, device: string): void {
    const want = this.store.wantFor(author, device);
    if (!want) return;
    const head = this.store.head(author, device);
    if (head && head.seq >= want.seq) return;
    this.requestChain(connection, author, device);
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
    // The awaits above yield: stop() may have closed the store underneath us
    // (a short-lived process — the CLI — exits seconds after start).
    if (!this.started) return null;
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

    // If we hold the whole chain, a checkpoint that disagrees with it is a
    // fork. Say so out loud rather than quietly keeping both.
    const head = this.store.head(message.author, message.device);
    if (head && head.seq + 1 >= message.count) {
      const ours = await this.store.localRoot(message.author, message.device);
      if (ours && ours !== message.root) {
        this.log(
          `fork: ${message.author.slice(0, 8)} has two histories (checkpoint ${message.root.slice(0, 8)} ≠ ours ${ours.slice(0, 8)})`,
        );
        this.emit("update", "fork");
      }
    }

    // If we are behind that root, we want the events it covers.
    if (!head || head.seq < message.seq) {
      this.noteHead(message.author, message.device, message.seq);
    }

    // We do not hold this chain at all. Ask for a proof that the chain is
    // real before we pull it: a checkpoint on its own is a claim, a proof is
    // a fact.
    if (!head) {
      this.pendingProofs.set(`${message.author}|${message.device}`, message.root);
      connection.send({
        t: "proof-want",
        author: message.author,
        device: message.device,
        seq: message.seq,
      });
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

  private pendingBlobs = new BlobTransfer();

  /**
   * Take in a blob, one chunk at a time.
   *
   * A peer is not trusted with this machine's memory: the bytes are capped,
   * the number of open transfers is capped, a transfer that stalls is dropped,
   * and the peer may not change its mind about the size halfway through. All
   * of that lives in `BlobTransfer`; this is only the wiring.
   */
  private async receiveBlobChunk(message: {
    hash: string;
    index: number;
    total: number;
    data: string;
  }): Promise<void> {
    const result = this.pendingBlobs.accept(
      message.hash,
      message.index,
      message.total,
      message.data,
    );

    if (result.status === "rejected") {
      this.log(`dropped a blob chunk: ${result.reason}`);
      return;
    }
    if (result.status === "pending") return;

    const bytes = result.bytes;
    if (!(await verifyBlob(message.hash, bytes))) {
      this.log(`rejected a blob: its bytes do not match ${message.hash.slice(0, 8)}`);
      return;
    }
    // The type the author declared, when a post has said anything about it.
    const type = this.store.mediaType(message.hash) ?? "application/octet-stream";
    const ref: BlobRef = { hash: message.hash, size: bytes.length, type };
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
