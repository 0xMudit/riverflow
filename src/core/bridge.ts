/**
 * The IPC contract between the node process and the window.
 *
 * The renderer can read state and ask the node to sign things. It cannot read
 * the private key, cannot touch the database, and cannot open sockets. Anything
 * that crosses this boundary is explicit.
 */
import type {
  DeviceView,
  Event,
  EventBody,
  EventKind,
  NotificationView,
  PeerView,
  PostView,
  ProfileView,
  Snapshot,
  ThreadView,
  VerifyReport,
} from "./types";
import type { Checkpoint } from "./merkle";

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
