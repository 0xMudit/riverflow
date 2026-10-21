/**
 * Ambient types for the two hole-punching packages River uses.
 *
 * They ship no type definitions, and River uses only a small part of them, so
 * the surface is declared here rather than pulling in a wider surface we do
 * not depend on. If the packages change shape, this file is where to notice.
 */
declare module "hyperswarm" {
  import type { EventEmitter } from "node:events";

  export interface SwarmKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface SwarmPeerInfo {
    /** the peer's transport key */
    publicKey: Uint8Array;
    /** true when this side dialled out */
    client: boolean;
    topics: Uint8Array[];
    banned: boolean;
  }

  export interface SwarmSocket {
    /** returns false when the socket's buffer is full; wait for "drain" */
    write(data: string): boolean;
    on(event: "data", handler: (chunk: Uint8Array) => void): void;
    on(event: "close", handler: () => void): void;
    on(event: "error", handler: (error: Error) => void): void;
    on(event: "drain", handler: () => void): void;
    on(event: string, handler: (...args: never[]) => void): void;
    destroy(): void;
    remotePublicKey?: Uint8Array;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: {
      dht?: unknown;
      keyPair?: SwarmKeyPair;
      maxPeers?: number;
      firewall?: (remotePublicKey: Uint8Array) => boolean;
    });
    keyPair: SwarmKeyPair;
    dht: unknown;
    peers: Map<string, SwarmPeerInfo>;
    listen(): Promise<void>;
    joinPeer(publicKey: Uint8Array): void;
    leavePeer(publicKey: Uint8Array): void;
    destroy(): Promise<void>;
    on(event: "connection", handler: (socket: SwarmSocket, info: SwarmPeerInfo) => void): this;
    on(event: "update", handler: () => void): this;
  }
}

declare module "hyperdht" {
  import type { EventEmitter } from "node:events";
  import type { SwarmKeyPair } from "hyperswarm";

  export interface DhtReply {
    peers?: Array<{ publicKey: Uint8Array; relayAddresses?: string[] }>;
    token?: Uint8Array;
  }

  export default class DHT extends EventEmitter {
    constructor(options?: {
      port?: number;
      host?: string;
      bootstrap?: string[];
      ephemeral?: boolean;
      keyPair?: SwarmKeyPair;
    });
    /** Run a node that introduces peers to each other. */
    static bootstrapper(port: number, host: string, options?: { bootstrap?: string[] }): DHT;
    static keyPair(seed?: Uint8Array): SwarmKeyPair;
    announce(target: Uint8Array, keyPair: SwarmKeyPair): AsyncIterable<DhtReply>;
    lookup(target: Uint8Array): AsyncIterable<DhtReply>;
    destroy(options?: { force?: boolean }): Promise<void>;
    on(event: "ready" | "persistent" | "listening", handler: () => void): this;
    on(event: "error", handler: (error: Error) => void): this;
  }
}
