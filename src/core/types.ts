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
  | "profile"
  | "device";

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
  /** device: the key being authorised to write for this identity */
  device?: string;
  /** device: the owner is withdrawing that authority */
  revoked?: boolean;
  /** post: media attached, by content hash */
  media?: BlobRef[];
}

/** A media blob, addressed by the hash of its bytes. */
export interface BlobRef {
  hash: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

/** How an author signs. The default is ed25519; "eth" is a wallet key. */
export type EventScheme = "ed25519" | "eth";

export interface Event {
  /** sha256 over the canonical form of {author, device, seq, prev, kind, body, createdAt} */
  id: string;
  /** ed25519 public key, hex. This is the account. */
  author: string;
  /**
   * The signature scheme the author used. Absent means ed25519, so an event
   * written before wallets existed keeps the id it always had.
   */
  scheme?: EventScheme;
  /**
   * The device key that signed this event, when it is not the root key.
   * Empty means the root key wrote it. Each device keeps its own chain, so
   * two machines never fork one person's history.
   */
  device?: string;
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
  device: string;
  seq: number;
  id: string;
}

/** A device an identity has authorised to write on its behalf. */
export interface DeviceView {
  device: string;
  name: string;
  seq: number;
  createdAt: number;
  /** the owner has withdrawn this device's authority */
  revoked: boolean;
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

/**
 * An event the node has prepared but not signed.
 *
 * When the signer is a wallet, the key lives in the wallet and not here: the
 * node works out where the event belongs and what its id will be, and the
 * person signs that id in their wallet.
 */
export interface EventDraftView {
  author: string;
  scheme: EventScheme;
  seq: number;
  prev: string;
  kind: EventKind;
  body: EventBody;
  createdAt: number;
  id: string;
  /** the bytes to sign, hex */
  digest: string;
  /** how the signer must sign them */
  signing: "ed25519" | "personal_sign";
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
  /** media attached, addressed by the hash of its bytes */
  media?: BlobRef[];
  /** the device key that wrote it, when it was not the root key */
  device?: string;
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
  /** how many people the viewer follows */
  following: number;
  retracted: number;
  reactions: number;
}

/** Derived from the log, never authored: what happened to *you*. */
export interface NotificationView {
  id: string;
  kind: "reply" | "reaction" | "follow";
  actor: string;
  postId: string | null;
  text: string;
  createdAt: number;
  seen: boolean;
}

/** An address this node has met before. Kept so it can dial back in later. */
export interface KnownPeer {
  address: string;
  nodeId: string | null;
  lastSeen: number;
  failures: number;
  nextTry: number;
}

export interface FeedPage {
  top: PostView[];
  replies: PostView[];
  /** pass back as `before` to continue; null when the flow is exhausted */
  next: { createdAt: number; id: string } | null;
}

export interface ThreadView {
  root: PostView | null;
  posts: PostView[];
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
  notifications: NotificationView[];
  unread: number;
  muted: string[];
}

export interface VerifyReport {
  ok: boolean;
  authors: number;
  events: number;
  errors: Array<{ author: string; seq: number; code: string; detail: string }>;
  checkedAt: number;
  durationMs: number;
}
