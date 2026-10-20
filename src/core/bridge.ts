/**
 * The IPC contract between the node process and the window.
 *
 * The renderer can read state and ask the node to sign things. It cannot read
 * the private key, cannot touch the database, and cannot open sockets. Anything
 * that crosses this boundary is explicit.
 */
import type {
  Event,
  EventBody,
  EventKind,
  PeerView,
  PostView,
  ProfileView,
  Snapshot,
  VerifyReport,
} from "./types";

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

export interface RiverBridge {
  snapshot(includeSilt?: boolean): Promise<Snapshot>;
  publish(kind: EventKind, body: EventBody): Promise<Event>;
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
  onUpdate(handler: () => void): () => void;
  onLog(handler: (line: string) => void): () => void;
  openExternal(url: string): void;
  versions(): Promise<{ app: string; electron: string; node: string }>;
}
