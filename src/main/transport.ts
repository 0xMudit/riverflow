/**
 * Transport: the only part of River that touches the network.
 *
 * Two mechanisms, both serverless:
 *   1. TCP, newline-delimited JSON frames — every message is a whole object.
 *   2. UDP broadcast for local discovery, so two machines on the same network
 *      find each other with no directory, no domain and no account.
 *
 * Nothing here decides what is true; it only moves bytes between nodes. The
 * node verifies everything it receives.
 */
import { EventEmitter } from "node:events";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

export type WireMessage =
  | { t: "hello"; v: number; nodeId: string; port: number; heads: Array<[string, number]> }
  | { t: "have"; heads: Array<[string, number]> }
  | { t: "want"; ranges: Array<[string, number, number]> }
  | { t: "events"; events: unknown[] }
  | { t: "bye" };

export interface Connection {
  id: string;
  address: string;
  direction: "in" | "out";
  since: number;
  lastSeen: number;
  send(message: WireMessage): void;
  close(): void;
}

const MAX_FRAME = 16 * 1024 * 1024;

export class PeerServer extends EventEmitter {
  private server: Server | null = null;
  private udp: UdpSocket | null = null;
  private connections = new Map<string, Connection>();
  private timer: NodeJS.Timeout | null = null;
  private port = 0;

  constructor(
    private readonly options: {
      nodeId: string;
      port: number;
      discoveryPort: number;
      discovery: boolean;
    },
  ) {
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

  async listen(): Promise<number> {
    const server = createServer((socket) => this.accept(socket, "in"));
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

    if (this.options.discovery) this.startDiscovery();
    return this.port;
  }

  private accept(socket: Socket, direction: "in" | "out"): Connection {
    socket.setNoDelay(true);
    const id = randomBytes(8).toString("hex");
    const address = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`.replace("::ffff:", "");

    const connection: Connection = {
      id,
      address,
      direction,
      since: Date.now(),
      lastSeen: Date.now(),
      send: (message) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
      },
      close: () => socket.destroy(),
    };

    this.connections.set(id, connection);
    socket.setEncoding("utf8");

    let buffer = "";
    socket.on("data", (chunk: string) => {
      connection.lastSeen = Date.now();
      buffer += chunk;
      if (buffer.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) {
          try {
            this.emit("message", connection, JSON.parse(line) as WireMessage);
          } catch {
            socket.destroy();
            return;
          }
        }
        index = buffer.indexOf("\n");
      }
    });

    const done = () => {
      if (!this.connections.has(id)) return;
      this.connections.delete(id);
      this.emit("close", connection);
    };
    socket.on("close", done);
    socket.on("error", () => socket.destroy());

    this.emit("connection", connection);
    return connection;
  }

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
        resolve(this.accept(socket, "out"));
      });

      socket.once("error", onError);
    });
  }

  private startDiscovery() {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.udp = socket;

    socket.on("error", () => socket.close());
    socket.on("message", (data, rinfo) => {
      try {
        const announce = JSON.parse(data.toString()) as {
          app?: string;
          nodeId?: string;
          port?: number;
        };
        if (announce.app !== "river" || !announce.port) return;
        if (announce.nodeId === this.options.nodeId) return;
        // The node decides whether it already knows this peer.
        this.emit("discovered", `${rinfo.address}:${announce.port}`, announce.nodeId);
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
      this.timer = setInterval(() => this.announce(), 4000);
    });
  }

  private announce() {
    if (!this.udp || !this.port) return;
    const payload = JSON.stringify({
      app: "river",
      v: 1,
      nodeId: this.options.nodeId,
      port: this.port,
    });
    try {
      this.udp.send(payload, this.options.discoveryPort, "255.255.255.255");
    } catch {
      /* offline: fine */
    }
  }

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

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.udp?.close();
    this.udp = null;
    this.server?.close();
    this.server = null;
  }
}
