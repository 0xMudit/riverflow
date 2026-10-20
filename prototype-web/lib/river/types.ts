/**
 * RIVER — core ledger types.
 *
 * The mental model, in one paragraph:
 *
 *   The chain is an append-only sequence of blocks. Each block carries signed
 *   events. An event is the only thing a client may create. There is no
 *   "update" and no "delete" in this system — only new events that describe
 *   what happened. Readable state (a feed, a profile, a follow graph) is a
 *   *projection*: a pure fold over the event log. Nothing is ever removed,
 *   so any past state can be recomputed exactly, forever.
 */

export type EventKind =
  | "post"
  | "edit"
  | "retract"
  | "reaction"
  | "follow"
  | "profile";

export interface EventBody {
  /** post, edit */
  text?: string;
  /** post: the event id this post replies to */
  replyTo?: string;
  /** edit, retract, reaction: the event id being acted upon */
  target?: string;
  /** reaction */
  emoji?: string;
  /** profile */
  name?: string;
  bio?: string;
  hue?: number;
  /** retract: optional public note about why */
  reason?: string;
  /** follow: appends an unfollow instead (the follow still stays on the chain) */
  unfollow?: boolean;
}

export interface RiverEvent {
  /** sha256 over the canonical form of {author, kind, body, createdAt} */
  id: string;
  /** ed25519 public key, hex. This IS the account. */
  author: string;
  kind: EventKind;
  body: EventBody;
  createdAt: number;
  /** ed25519 signature over the raw id bytes, hex */
  sig: string;
}

export interface Block {
  index: number;
  /** hash of the previous block; 64 zeros for genesis */
  prevHash: string;
  timestamp: number;
  difficulty: number;
  nonce: number;
  events: RiverEvent[];
  merkleRoot: string;
  /** sha256 over the canonical block header */
  hash: string;
}

export interface Chain {
  blocks: Block[];
  height: number;
  difficulty: number;
}

export type ChainErrorCode =
  | "bad-hash"
  | "broken-link"
  | "bad-merkle"
  | "insufficient-work"
  | "bad-index"
  | "bad-event"
  | "bad-signature";

export interface ChainError {
  code: ChainErrorCode;
  block: number;
  detail: string;
}

export interface VerificationReport {
  ok: boolean;
  height: number;
  events: number;
  errors: ChainError[];
  /** event id -> signature + id integrity */
  eventValidity: Record<string, boolean>;
  checkedAt: number;
}
