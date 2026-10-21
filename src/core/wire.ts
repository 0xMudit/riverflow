/**
 * The wire protocol, version 3.
 *
 * Every message is one JSON object on one line. Two transports carry it: a
 * plain TCP socket (same network, or an address someone gave you) and a
 * Noise-encrypted stream punched through a NAT by the DHT. The bytes on the
 * wire are the same, so a node does not care how it was connected.
 *
 * Version 3 adds three things version 2 lacked: a signed handshake, so a peer
 * on the other end proves which key it holds instead of asserting a node id;
 * subscription sets, so two nodes do not exchange a head for every author in
 * the world; and checkpoints, so a node can trust a suffix of a log it has
 * never seen in full.
 *
 * Version 3 changes the handshake. Each side sends a nonce, and the second
 * hello each side sends signs the nonce it was given. A hello captured on one
 * connection therefore cannot be replayed onto another, because the nonce it
 * carries belongs to a connection that is over.
 */
import { canonical } from "./canonical";
import { sign, verify } from "./crypto";
import type { Event } from "./types";

export const PROTOCOL_VERSION = 3;

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
      /** the nonce the other side sent us; empty on an opening hello */
      peerNonce: string;
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
  | { t: "proof-want"; author: string; device: string; seq: number }
  | { t: "blob-want"; hash: string }
  | { t: "blob-chunk"; hash: string; index: number; total: number; data: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number }
  | { t: "bye" };

/** The exact bytes a peer signs when it says hello. */
export function helloPayload(peer: string, addr: string, nonce: string, peerNonce = ""): string {
  return canonical({ v: PROTOCOL_VERSION, peer, addr, nonce, peerNonce });
}

/** Sign a hello. */
export function signHello(
  privateKeyHex: string,
  peer: string,
  addr: string,
  nonce: string,
  peerNonce = "",
): Promise<string> {
  return sign(privateKeyHex, new TextEncoder().encode(helloPayload(peer, addr, nonce, peerNonce)));
}

/**
 * Check a hello against the key the peer claims. A peer that cannot sign for
 * its own key is not the peer it says it is.
 *
 * The signature covers the nonce the peer sent *and* the nonce it was given.
 * That second half is what makes the handshake un-replayable: a hello that
 * was captured on one connection carries a nonce that does not match the next
 * connection, so it cannot be used to pass as that peer.
 */
export async function verifyHello(message: {
  peer: string;
  addr: string;
  nonce: string;
  peerNonce?: string;
  sig: string;
}): Promise<boolean> {
  if (!message || typeof message.peer !== "string" || typeof message.sig !== "string") return false;
  if (!/^[0-9a-f]{64}$/i.test(message.peer)) return false;
  if (message.sig.length === 0) return false;
  if (typeof message.nonce !== "string" || message.nonce.length === 0) return false;
  return verify(
    message.peer,
    new TextEncoder().encode(
      helloPayload(message.peer, message.addr, message.nonce, message.peerNonce ?? ""),
    ),
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
        typeof message.peerNonce === "string" &&
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
    case "proof-want":
      return typeof message.author === "string" && typeof message.seq === "number";
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
  /** how many bytes the buffer holds */
  private size = 0;

  constructor(private readonly limit: number = MAX_FRAME_BYTES) {}

  /**
   * Returns the messages that are complete, and whether the stream is still
   * sane.
   *
   * The chunk is measured before it is held. A peer must not be able to make
   * this node allocate whatever it likes to send: the limit is checked before
   * the copy, not after it.
   */
  push(chunk: string, bytes = utf8Length(chunk)): { messages: WireMessage[]; overflow: boolean } {
    if (this.size + bytes > this.limit) {
      this.buffer = "";
      this.size = 0;
      return { messages: [], overflow: true };
    }
    this.buffer += chunk;
    this.size += bytes;

    const messages: WireMessage[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.size -= utf8Length(line) + 1;
      if (this.size < 0) this.size = 0;
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

/**
 * How many bytes a string takes in UTF-8, without encoding it.
 *
 * The frame limit is about memory, so it is counted in bytes. Measuring
 * characters would let a peer send three times the limit in CJK, and would
 * make the limit mean something different from what it says.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) as number;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else {
      bytes += 4;
      index++; // the low surrogate is part of the same character
    }
  }
  return bytes;
}
