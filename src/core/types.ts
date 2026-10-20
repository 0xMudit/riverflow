/**
 * RIVER — data model.
 *
 * One identity = one hash-chained log. Every event names the one before it, so
 * an author's history is a chain that cannot be reordered, truncated or
 * back-dated. The union of all logs is a DAG linked by references (replies,
 * edits, reactions), and *that* is the network's ledger.
 *
 * There is no global block and no mining: at a million simultaneous writers
 * there is nothing to agree on globally, and no one needs to win a race to
 * speak. Signatures prove authorship; the chain proves the past.
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
  /** post: event id of the parent post */
  replyTo?: string;
  /** edit, retract, reaction: event id being acted upon */
  target?: string;
  /** reaction */
  emoji?: string;
  /** profile */
  name?: string;
  bio?: string;
  hue?: number;
  /** retract: public note */
  reason?: string;
  /** follow: append an unfollow instead (the follow stays on the log) */
  unfollow?: boolean;
}

export interface Event {
  /** sha256 over the canonical form of {author, seq, prev, kind, body, createdAt} */
  id: string;
  /** ed25519 public key, hex. This is the account. */
  author: string;
  /** position in this author's log, starting at 0 */
  seq: number;
  /** id of the previous event in this author's log; "" for seq 0 */
  prev: string;
  kind: EventKind;
  body: EventBody;
  createdAt: number;
  /** ed25519 signature over the raw id bytes */
  sig: string;
}

export interface LogHead {
  author: string;
  seq: number;
  id: string;
}

export type IngestStatus =
  | "added"
  | "duplicate"
  | "gap"
  | "orphan-author"
  | "invalid";

export interface IngestResult {
  status: IngestStatus;
  reason?: string;
}

export interface ProfileView {
  pubkey: string;
  name: string;
  bio: string;
  hue: number;
  seq: number;
}

export interface PostView {
  id: string;
  author: string;
  text: string;
  replyTo: string | null;
  root: string | null;
  createdAt: number;
  editedAt: number | null;
  seq: number;
  retracted: boolean;
  retractReason: string | null;
  reactions: number;
  replyCount: number;
  /** did the node's owner leave a ripple on this post? */
  viewerReacted: boolean;
  /** every stored event has a valid signature by construction */
  verified: boolean;
}

export interface PeerView {
  id: string;
  address: string | null;
  direction: "in" | "out";
  since: number;
  lastSeen: number;
  heads: number;
}

export interface EventView {
  id: string;
  author: string;
  seq: number;
  prev: string;
  kind: EventKind;
  createdAt: number;
  sig: string;
  body: EventBody;
  verified: boolean;
}

export interface Stats {
  authors: number;
  posts: number;
  events: number;
  follows: number;
  retracted: number;
  reactions: number;
}

export interface Snapshot {
  me: {
    pubkey: string;
    seq: number;
    name: string;
    bio: string;
    hue: number;
  } | null;
  posts: PostView[];
  replies: PostView[];
  profiles: Record<string, ProfileView>;
  following: string[];
  followers: string[];
  peers: PeerView[];
  listen: string | null;
  stats: Stats;
  includeSilt: boolean;
}

export interface VerifyReport {
  ok: boolean;
  authors: number;
  events: number;
  errors: Array<{ author: string; seq: number; code: string; detail: string }>;
  checkedAt: number;
  durationMs: number;
}
