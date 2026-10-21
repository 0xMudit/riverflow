/**
 * The IPC contract between the node process and the window.
 *
 * The renderer can read state and ask the node to sign things. It cannot read
 * the private key, cannot touch the database, and cannot open sockets. Anything
 * that crosses this boundary is explicit.
 */
import type {
  BlobRef,
  DeviceView,
  Event,
  EventBody,
  EventDraftView,
  EventKind,
  NotificationView,
  PeerView,
  PostView,
  ProfileView,
  Snapshot,
  ThreadView,
  VerifyReport,
} from "./types";
import type { Checkpoint, MerkleProof } from "./merkle";

export interface AuthorBundle {
  profile: ProfileView | null;
  posts: PostView[];
  events: Event[];
}

export interface IdentityInfo {
  publicKey: string;
  path: string;
  protected: boolean;
}

export interface BootStatus {
  ok: boolean;
  error: string | null;
  identityLocked: boolean;
}

export interface BreachReport extends VerifyReport {
  removedSeq: number | null;
}

export interface DialResult {
  ok: boolean;
  error?: string;
}

/** What the network looks like from this machine. */
export interface NetworkStatus {
  /** the address other people can dial */
  listen: string | null;
  /** the DHT: is it on, is it working, how many peers it knows */
  dht: {
    enabled: boolean;
    active: boolean;
    peers: number;
    bootstrap: string[];
    error: string | null;
  };
  /** this node keeps other people's logs */
  relay: boolean;
  peers: PeerView[];
  /** the authors this node has subscribed to */
  subscriptions: string[];
  /** heads this node has heard about but does not hold */
  wanted: number;
}

export type CheckpointView = Checkpoint & { sig: string };

/** The device key this machine holds, and whether it may write. */
export interface ThisDevice {
  publicKey: string;
  name: string;
  /** the identity has authorised this key */
  authorised: boolean;
  /** the identity has withdrawn this key's authority */
  revoked: boolean;
}

/** The wallet this machine is using, if any. */
export interface WalletInfo {
  address: string;
  /** the wallet has proved it holds the key */
  signedIn: boolean;
}

/** A sign-in statement for a wallet to sign. */
export interface Challenge {
  message: string;
  nonce: string;
}

export interface RiverBridge {
  snapshot(includeSilt?: boolean): Promise<Snapshot>;
  publish(kind: EventKind, body: EventBody): Promise<Event>;
  /** publish from a delegated device key */
  publishAs(kind: EventKind, body: EventBody, device: string): Promise<Event>;
  dial(address: string): Promise<DialResult>;
  peers(): Promise<PeerView[]>;
  verify(): Promise<VerifyReport>;
  breach(mode: "erase" | "rewrite"): Promise<BreachReport>;
  trail(postId: string): Promise<Event[]>;
  author(pubkey: string): Promise<AuthorBundle>;
  identity(): Promise<IdentityInfo>;
  exportKey(): Promise<string>;
  importKey(privateKey: string): Promise<IdentityInfo>;
  bootStatus(): Promise<BootStatus>;
  /** Renames an unreadable key file and restarts. Never deletes history. */
  resetIdentity(): Promise<void>;
  network(): Promise<NetworkStatus>;
  checkpoints(author?: string): Promise<CheckpointView[]>;
  devices(): Promise<DeviceView[]>;
  authoriseDevice(device: string, name: string): Promise<Event>;
  /** the device key this machine holds */
  thisDevice(): Promise<ThisDevice>;
  /** let this machine's own key write on its own chain */
  authoriseThisDevice(name: string): Promise<Event>;
  /** withdraw a device's authority; its past stays, its future stops */
  revokeDevice(device: string): Promise<Event>;
  /** hand over media, addressed by the hash of its bytes */
  attachMedia(bytes: Uint8Array, type: string, width?: number, height?: number): Promise<BlobRef>;
  /** an inclusion proof that an event is in a log this node holds */
  proof(author: string, device: string, seq: number): Promise<MerkleProof | null>;
  /** prepare an event for a wallet to sign */
  draft(kind: EventKind, body: EventBody): Promise<EventDraftView>;
  /** take an event a wallet signed, check it, and file it */
  submit(event: Event): Promise<Event>;
  /** the wallet this machine is using */
  wallet(): Promise<WalletInfo | null>;
  /** tell the node which wallet to write as */
  useWallet(address: string | null): Promise<void>;
  /** a statement the wallet can sign to prove it is yours */
  challenge(): Promise<Challenge>;
  /** check the signature that came back with the statement */
  signIn(message: string, signature: string): Promise<boolean>;
  mute(target: string): Promise<void>;
  unmute(target: string): Promise<void>;
  markRead(): Promise<void>;
  search(query: string): Promise<PostView[]>;
  thread(postId: string): Promise<ThreadView>;
  onUpdate(handler: () => void): () => void;
  onLog(handler: (line: string) => void): () => void;
  openExternal(url: string): void;
  versions(): Promise<{ app: string; electron: string; node: string }>;
}

export type { NotificationView };
