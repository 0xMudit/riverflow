/**
 * The wire protocol, version 2.
 *
 * Every message is one JSON object on one line. Two transports carry it: a
 * plain TCP socket (same network, or an address someone gave you) and a
 * Noise-encrypted stream punched through a NAT by the DHT. The bytes on the
 * wire are the same, so a node does not care how it was connected.
 *
 * Version 2 adds three things version 1 lacked: a signed handshake, so a peer
 * on the other end proves which key it holds instead of asserting a node id;
 * subscription sets, so two nodes do not exchange a head for every author in
 * the world; and checkpoints, so a node can trust a suffix of a log it has
 * never seen in full.
 */
import { canonical } from "./canonical";
import { sign, verify } from "./crypto";
import type { Event } from "./types";

export const PROTOCOL_VERSION = 2;

/** A frame larger than this is a bug or an attack. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** One chain position: author, device, and the seq it has reached. */
export type ChainHead = [author: string, device: string, seq: number];

export type WireMessage =
  | {
      t: "hello";
      v: number;
      /** ed25519 public key of the sending peer — its stable id */
      peer: string;
      /** the address the peer can be reached at, for the address book */
      addr: string;
      /** random hex, replayed in the signature */
      nonce: string;
      /** ed25519 signature over helloPayload */
      sig: string;
      /** the chains the peer holds */
      chains: ChainHead[];
    }
  | { t: "have"; chains: ChainHead[] }
  | { t: "subs"; authors: string[] }
  | { t: "want"; ranges: Array<[author: string, device: string, from: number, to: number]> }
  | { t: "events"; events: Event[] }
  | {
      t: "checkpoint";
      author: string;
      device: string;
      seq: number;
      root: string;
      count: number;
      at: number;
      sig: string;
    }
  | {
      t: "proof";
      author: string;
      device: string;
      seq: number;
      leaf: string;
      root: string;
      index: number;
      size: number;
      path: string[];
    }
  | { t: "blob-want"; hash: string }
  | { t: "blob-chunk"; hash: string; index: number; total: number; data: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number }
  | { t: "bye" };

/** The exact bytes a peer signs when it says hello. */
export function helloPayload(peer: string, addr: string, nonce: string): string {
  return canonical({ v: PROTOCOL_VERSION, peer, addr, nonce });
}

/** Sign a hello. */
export function signHello(
  privateKeyHex: string,
  peer: string,
  addr: string,
  nonce: string,
): Promise<string> {
  return sign(privateKeyHex, new TextEncoder().encode(helloPayload(peer, addr, nonce)));
}

/**
 * Check a hello against the key the peer claims. A peer that cannot sign for
 * its own key is not the peer it says it is.
 */
export async function verifyHello(message: {
  peer: string;
  addr: string;
  nonce: string;
  sig: string;
}): Promise<boolean> {
  if (!message || typeof message.peer !== "string" || typeof message.sig !== "string") return false;
  if (!/^[0-9a-f]{64}$/i.test(message.peer)) return false;
  if (message.sig.length === 0) return false;
  return verify(
    message.peer,
    new TextEncoder().encode(helloPayload(message.peer, message.addr, message.nonce)),
    message.sig,
  );
}

/** True when the message is a well-formed frame of a known type. */
export function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.t) {
    case "hello":
      return (
        message.v === PROTOCOL_VERSION &&
        typeof message.peer === "string" &&
        typeof message.nonce === "string" &&
        typeof message.sig === "string"
      );
    case "have":
      return Array.isArray(message.chains);
    case "subs":
      return Array.isArray(message.authors);
    case "want":
      return Array.isArray(message.ranges);
    case "events":
      return Array.isArray(message.events);
    case "checkpoint":
      return typeof message.author === "string" && typeof message.root === "string";
    case "proof":
      return typeof message.author === "string" && Array.isArray(message.path);
    case "blob-want":
      return typeof message.hash === "string";
    case "blob-chunk":
      return typeof message.hash === "string" && typeof message.data === "string";
    case "ping":
    case "pong":
      return typeof message.at === "number";
    case "bye":
      return true;
    default:
      return false;
  }
}

/** Encode one message as a frame. */
export function encodeFrame(message: WireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Frames arrive in arbitrary pieces. Feed them here and get whole messages
 * back; anything past the size limit ends the connection.
 */
export class FrameDecoder {
  private buffer = "";

  constructor(private readonly limit: number = MAX_FRAME_BYTES) {}

  /** Returns the messages that are complete, and whether the stream is still sane. */
  push(chunk: string): { messages: WireMessage[]; overflow: boolean } {
    this.buffer += chunk;
    if (this.buffer.length > this.limit) {
      this.buffer = "";
      return { messages: [], overflow: true };
    }

    const messages: WireMessage[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isWireMessage(parsed)) messages.push(parsed);
        } catch {
          /* a frame we cannot parse is dropped, not fatal */
        }
      }
      index = this.buffer.indexOf("\n");
    }
    return { messages, overflow: false };
  }

  get pending(): number {
    return this.buffer.length;
  }
}
