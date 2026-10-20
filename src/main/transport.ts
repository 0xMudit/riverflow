/**
 * Transport: the only part of River that touches the network.
 *
 * Three ways in, one way to talk:
 *
 *   1. TCP — an address someone handed you, or a machine on the same network.
 *   2. LAN discovery — a UDP broadcast every few seconds, so two laptops on
 *      the same wifi find each other with no directory, no domain, no account.
 *   3. The DHT — peers find each other across NATs by announcing a topic and
 *      punching a hole through both firewalls. That traffic is Noise-encrypted
 *      end to end, so the DHT relays addresses and never sees a post.
 *
 * All three carry the same frames (core/wire.ts). Nothing here decides what is
 * true; it only moves bytes between nodes.
 */
import { EventEmitter } from "node:events";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

import { fromHex, toHex } from "../core/canonical";
import {
  FrameDecoder,
  encodeFrame,
  isWireMessage,
  signHello,
  verifyHello,
  type ChainHead,
  type WireMessage,
} from "../core/wire";

/** A duplex byte pipe, whether it came from TCP or from the DHT. */
export interface BytePipe {
  write(data: string): void;
  on(event: "data", handler: (chunk: Uint8Array | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  destroy(): void;
  /** true once the pipe is gone */
  readonly destroyed?: boolean;
}

export interface Connection {
  id: string;
  /** where the peer is, as far as we know */
  address: string;
  direction: "in" | "out";
  since: number;
  lastSeen: number;
  /** the peer's ed25519 key, once it has proved it holds that key */
  peer: string | null;
  /** the peer's transport key, for DHT peers we may want to dial again */
  transport: string | null;
  send(message: WireMessage): void;
  close(): void;
}

export interface DhtStatus {
  enabled: boolean;
  active: boolean;
  /** peers the DHT has told us about */
  peers: number;
  /** bootstrap nodes we were pointed at */
  bootstrap: string[];
  error: string | null;
}

export interface TransportOptions {
  peer: { publicKey: string; privateKey: string; transportSeed: string };
  port: number;
  discoveryPort: number;
  /** LAN broadcast discovery */
  discovery: boolean;
  /** DHT discovery and hole punching */
  dht: boolean;
  dhtBootstrap: string[];
  /** 32-byte topic the node joins */
  topic: Uint8Array;
  /** the chains this node holds, for the handshake */
  chains: () => ChainHead[];
  log?: (line: string) => void;
}

const HELLO_TIMEOUT = 10_000;
const DISCOVERY_INTERVAL = 4000;
const DHT_LOOKUP_INTERVAL = 30_000;

export class PeerServer extends EventEmitter {
  private server: Server | null = null;
  private udp: UdpSocket | null = null;
  private connections = new Map<string, Connection>();
  private timer: NodeJS.Timeout | null = null;
  private port = 0;

  private swarm: import("hyperswarm").default | null = null;
  private dht: import("hyperdht").default | null = null;
  private dhtTimer: NodeJS.Timeout | null = null;
  private dhtWatchdog: NodeJS.Timeout | null = null;
  private dhtBusy = false;
  private dhtPeers = new Set<string>();
  private dhtError: string | null = null;
  private dhtActive = false;
  private started = false;

  constructor(private readonly options: TransportOptions) {
    super();
  }

  get listenPort(): number {
    return this.port;
  }

  /** Best-guess address another person could dial, for the "invite" panel. */
  address(): string | null {
    if (!this.port) return null;
    for (const [, addresses] of Object.entries(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          return `${address.address}:${this.port}`;
        }
      }
    }
    return `127.0.0.1:${this.port}`;
  }

  dhtStatus(): DhtStatus {
    return {
      enabled: this.options.dht,
      active: this.dhtActive,
      peers: this.dhtPeers.size,
      bootstrap: this.options.dhtBootstrap,
      error: this.dhtError,
    };
  }

  async listen(): Promise<number> {
    const server = createServer((socket) => this.accept(socket, "in", null));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : this.options.port;
    this.started = true;

    if (this.options.discovery) this.startDiscovery();
    if (this.options.dht) void this.startDht();
    return this.port;
  }

  // ------------------------------------------------------------------ streams

  private accept(
    pipe: BytePipe,
    direction: "in" | "out",
    transport: string | null,
    address?: string,
  ): Connection {
    const id = randomBytes(8).toString("hex");
    const label = address ?? `peer:${transport?.slice(0, 8) ?? id}`;

    const connection: Connection = {
      id,
      address: label,
      direction,
      since: Date.now(),
      lastSeen: Date.now(),
      peer: null,
      transport,
      send: (message) => {
        try {
          if (!pipe.destroyed) pipe.write(encodeFrame(message));
        } catch {
          /* the peer went away mid-write */
        }
      },
      close: () => pipe.destroy(),
    };

    this.connections.set(id, connection);

    const decoder = new FrameDecoder();
    pipe.on("data", (chunk: Uint8Array | string) => {
      connection.lastSeen = Date.now();
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      const { messages, overflow } = decoder.push(text);
      if (overflow) {
        pipe.destroy();
        return;
      }
      for (const message of messages) this.onMessage(connection, message);
    });

    pipe.on("error", () => pipe.destroy());

    const done = () => {
      if (!this.connections.has(id)) return;
      this.connections.delete(id);
      this.emit("close", connection);
    };
    pipe.on("close", done);

    // Prove who we are before saying anything else.
    void this.sendHello(connection);

    this.emit("connection", connection);
    return connection;
  }

  private async sendHello(connection: Connection): Promise<void> {
    try {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const sig = await signHello(
        this.options.peer.privateKey,
        this.options.peer.publicKey,
        connection.address,
        nonce,
      );
      connection.send({
        t: "hello",
        v: 2,
        peer: this.options.peer.publicKey,
        addr: connection.address,
        nonce,
        sig,
        chains: this.options.chains(),
      });
    } catch (error) {
      this.log(`could not sign the handshake: ${(error as Error).message}`);
    }
  }

  private onMessage(connection: Connection, message: WireMessage) {
    if (!isWireMessage(message)) return;

    if (message.t === "hello") {
      void this.onHello(connection, message);
      return;
    }

    if (message.t === "bye") {
      connection.close();
      return;
    }

    this.emit("message", connection, message);
  }

  private async onHello(
    connection: Connection,
    message: Extract<WireMessage, { t: "hello" }>,
  ): Promise<void> {
    const ok = await verifyHello(message);
    if (!ok) {
      this.log(`a peer claimed to be ${message.peer.slice(0, 8)} but could not prove it`);
      connection.close();
      return;
    }
    if (connection.peer && connection.peer !== message.peer) {
      this.log("a peer changed its key mid-connection; dropping it");
      connection.close();
      return;
    }

    const first = connection.peer === null;
    connection.peer = message.peer;
    this.emit("auth", connection, message.chains);

    // Answer a hello with a hello: the side that dialled may not have spoken yet.
    if (first) await this.sendHello(connection);
  }

  // ----------------------------------------------------------------- outbound

  dial(address: string, timeoutMs = 6000): Promise<Connection> {
    const [host, rawPort] = address.replace(/^tcp:\/\//, "").split(":");
    const port = Number(rawPort);
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no answer from ${address}`));
      }, timeoutMs);

      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(this.accept(socket as unknown as BytePipe, "out", null, address));
      });

      socket.once("error", onError);
    });
  }

  /** Dial a peer we met through the DHT, by its transport key. */
  joinDhtPeer(transportKeyHex: string): void {
    if (!this.swarm) return;
    try {
      this.swarm.joinPeer(fromHex(transportKeyHex));
    } catch (error) {
      this.log(`could not reach ${transportKeyHex.slice(0, 8)}: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ the DHT

  private async startDht(): Promise<void> {
    try {
      const [{ default: Hyperswarm }, { default: DHT }] = await Promise.all([
        import("hyperswarm"),
        import("hyperdht"),
      ]);

      const dht = new DHT({
        // An empty list means "use the public bootstrap nodes"; hyperdht only
        // treats an explicit array as an override.
        bootstrap: this.options.dhtBootstrap.length > 0 ? this.options.dhtBootstrap : undefined,
        // A node that cannot be reached cannot announce anything: persistent
        // mode is what lets other peers find this one.
        ephemeral: false,
      });
      const keyPair = DHT.keyPair(fromHex(this.options.peer.transportSeed));
      const swarm = new Hyperswarm({ dht, keyPair, maxPeers: 32 });

      swarm.on("connection", (socket, info) => {
        const transport = toHex(info.publicKey);
        this.dhtPeers.add(transport);
        this.accept(socket, info.client ? "out" : "in", transport);
        this.emit("dht-peer", transport);
      });

      this.dht = dht;
      this.swarm = swarm;

      // A node that never hears from a bootstrap node is not on the network,
      // and the person should be told rather than left waiting.
      let ready = false;
      dht.on("ready", () => {
        ready = true;
        this.dhtActive = true;
        this.dhtError = null;
        this.emit("dht", this.dhtStatus());
      });
      dht.on("error", (error: Error) => {
        this.dhtError = error.message;
        this.emit("dht", this.dhtStatus());
      });
      this.dhtWatchdog = setTimeout(() => {
        if (ready || !this.started) return;
        this.dhtError =
          "no answer from the bootstrap nodes — you can run your own with `npm run bootstrap`";
        this.emit("dht", this.dhtStatus());
      }, 20_000);

      await swarm.listen();
      this.log(`dht: announced as ${toHex(keyPair.publicKey).slice(0, 8)}`);

      // Announce ourselves on the topic, then keep looking for others.
      void this.announceTopic();
      this.dhtTimer = setInterval(() => void this.lookupTopic(), DHT_LOOKUP_INTERVAL);
      void this.lookupTopic();
    } catch (error) {
      this.dhtError = (error as Error).message;
      this.log(`dht: unavailable (${this.dhtError})`);
      this.emit("dht", this.dhtStatus());
    }
  }

  private async announceTopic(): Promise<void> {
    if (!this.dht || !this.swarm) return;
    try {
      for await (const _reply of this.dht.announce(this.options.topic, this.swarm.keyPair)) {
        // The iterator stays open while we are announced; draining it keeps
        // the announcement alive.
        void _reply;
      }
    } catch (error) {
      this.dhtError = (error as Error).message;
      this.log(`dht: announce failed (${this.dhtError})`);
    }
  }

  private async lookupTopic(): Promise<void> {
    if (!this.dht || !this.swarm || this.dhtBusy) return;
    this.dhtBusy = true;
    try {
      for await (const reply of this.dht.lookup(this.options.topic)) {
        for (const peer of reply.peers ?? []) {
          const key = toHex(peer.publicKey);
          if (this.dhtPeers.has(key)) continue;
          this.dhtPeers.add(key);
          this.emit("dht-peer", key);
          this.swarm.joinPeer(peer.publicKey);
        }
      }
    } catch (error) {
      this.dhtError = (error as Error).message;
      this.log(`dht: lookup failed (${this.dhtError})`);
    } finally {
      this.dhtBusy = false;
      this.emit("dht", this.dhtStatus());
    }
  }

  // -------------------------------------------------------------- LAN discovery

  private startDiscovery() {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.udp = socket;

    socket.on("error", () => socket.close());
    socket.on("message", (data, rinfo) => {
      try {
        const announce = JSON.parse(data.toString()) as {
          app?: string;
          peer?: string;
          port?: number;
        };
        if (announce.app !== "river" || !announce.port) return;
        if (announce.peer === this.options.peer.publicKey) return;
        this.emit("discovered", `${rinfo.address}:${announce.port}`, announce.peer ?? null);
      } catch {
        /* not our packet */
      }
    });

    socket.bind(this.options.discoveryPort, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* some adapters refuse; explicit peers still work */
      }
      this.announce();
      this.timer = setInterval(() => this.announce(), DISCOVERY_INTERVAL);
    });
  }

  private announce() {
    if (!this.udp || !this.port) return;
    const payload = JSON.stringify({
      app: "river",
      v: 2,
      peer: this.options.peer.publicKey,
      port: this.port,
    });
    try {
      this.udp.send(payload, this.options.discoveryPort, "255.255.255.255");
    } catch {
      /* offline: fine */
    }
  }

  // ------------------------------------------------------------------ plumbing

  broadcast(message: WireMessage, exceptId?: string) {
    for (const [id, connection] of this.connections) {
      if (id === exceptId) continue;
      connection.send(message);
    }
  }

  send(id: string, message: WireMessage) {
    this.connections.get(id)?.send(message);
  }

  close(id: string) {
    this.connections.get(id)?.close();
  }

  get size(): number {
    return this.connections.size;
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.dhtTimer) clearInterval(this.dhtTimer);
    if (this.dhtWatchdog) clearTimeout(this.dhtWatchdog);
    this.timer = null;
    this.dhtTimer = null;
    this.dhtWatchdog = null;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.udp?.close();
    this.udp = null;
    this.server?.close();
    this.server = null;
    void this.swarm?.destroy();
    void this.dht?.destroy({ force: true });
    this.swarm = null;
    this.dht = null;
    this.dhtActive = false;
    this.started = false;
  }
}
