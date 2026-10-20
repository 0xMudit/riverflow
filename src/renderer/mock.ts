/**
 * Browser preview shim.
 *
 * Only loaded when `window.river` is absent — i.e. when the renderer is opened
 * in a plain browser instead of Electron. It fakes the IPC bridge with an
 * in-memory node so the interface can be reviewed without packaging the app.
 * It is never used inside Electron, and it never touches a real ledger.
 */
import type { RiverBridge } from "@/core/bridge";
import type { Event, EventBody, PostView, ProfileView, Snapshot } from "@/core/types";

const H = (seed: string) => seed.repeat(64).slice(0, 64);
const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

const ME = H("a1b2c3d4");
const MIRA = H("f0e1d2c3");

const profiles: Record<string, ProfileView> = {
  [ME]: { pubkey: ME, name: "mudit", bio: "building a river that cannot be drained", hue: 168, seq: 0 },
  [MIRA]: { pubkey: MIRA, name: "mira", bio: "on the other bank", hue: 28, seq: 0 },
};

const posts: PostView[] = [
  {
    id: H("1a1a1a1a"),
    author: ME,
    text: "A social network where nothing is deleted. Not hidden, not archived — still there, verifiable, forever.",
    replyTo: null,
    root: null,
    createdAt: minutes(41),
    editedAt: null,
    seq: 1,
    retracted: false,
    retractReason: null,
    reactions: 1,
    replyCount: 1,
    viewerReacted: false,
    verified: true,
  },
  {
    id: H("2b2b2b2b"),
    author: ME,
    text: "No server. No owner. Your key signs your words, and every event carries the hash of the one before it.",
    replyTo: null,
    root: null,
    createdAt: minutes(26),
    editedAt: null,
    seq: 2,
    retracted: false,
    retractReason: null,
    reactions: 0,
    replyCount: 0,
    viewerReacted: false,
    verified: true,
  },
  {
    id: H("3c3c3c3c"),
    author: MIRA,
    text: "Crossed over from a second node. My log is mine, and it only grows.",
    replyTo: null,
    root: null,
    createdAt: minutes(14),
    editedAt: null,
    seq: 1,
    retracted: false,
    retractReason: null,
    reactions: 0,
    replyCount: 0,
    viewerReacted: false,
    verified: true,
  },
  {
    id: H("4d4d4d4d"),
    author: ME,
    text: "A retraction here is not an eraser. It is a stone laid on top of the words — the current moves on, the riverbed keeps everything.",
    replyTo: null,
    root: null,
    createdAt: minutes(9),
    editedAt: null,
    seq: 3,
    retracted: false,
    retractReason: null,
    reactions: 0,
    replyCount: 0,
    viewerReacted: false,
    verified: true,
  },
  {
    id: H("5e5e5e5e"),
    author: MIRA,
    text: "this was a test post, gone in a moment",
    replyTo: null,
    root: null,
    createdAt: minutes(13),
    editedAt: null,
    seq: 2,
    retracted: true,
    retractReason: "served its purpose",
    reactions: 0,
    replyCount: 0,
    viewerReacted: false,
    verified: true,
  },
  {
    id: H("6f6f6f6f"),
    author: MIRA,
    text: "A reply that travelled over TCP, signed on this machine and verified on yours.",
    replyTo: H("1a1a1a1a"),
    root: H("1a1a1a1a"),
    createdAt: minutes(7),
    editedAt: null,
    seq: 4,
    retracted: false,
    retractReason: null,
    reactions: 1,
    replyCount: 0,
    viewerReacted: true,
    verified: true,
  },
];

let following = [MIRA];
let seq = { [ME]: 3, [MIRA]: 4 };

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function view(post: PostView, includeSilt: boolean): boolean {
  return includeSilt || !post.retracted;
}

function snapshot(includeSilt = false): Snapshot {
  const top = posts.filter((post) => !post.replyTo && view(post, includeSilt));
  const replies = posts.filter((post) => post.replyTo && view(post, includeSilt));
  const authors = new Set([ME, ...top.map((p) => p.author), ...replies.map((p) => p.author)]);
  const map: Record<string, ProfileView> = {};
  for (const author of authors) if (profiles[author]) map[author] = profiles[author];

  return {
    me: {
      pubkey: ME,
      seq: seq[ME],
      name: profiles[ME].name,
      bio: profiles[ME].bio,
      hue: profiles[ME].hue,
    },
    posts: top,
    replies,
    profiles: map,
    following,
    followers: [MIRA],
    peers: [
      {
        id: "9c12eea310ebad2e",
        address: "192.168.1.24:7400",
        direction: "in",
        since: minutes(12),
        lastSeen: now,
        heads: 2,
      },
    ],
    listen: "192.168.1.7:7331",
    stats: {
      authors: 2,
      posts: posts.length,
      events: posts.length + 8,
      follows: following.length,
      retracted: posts.filter((post) => post.retracted).length,
      reactions: 2,
    },
    includeSilt,
  };
}

function trail(postId: string): Event[] {
  const post = posts.find((candidate) => candidate.id === postId);
  if (!post) return [];
  const written: Event = {
    id: post.id,
    author: post.author,
    seq: 1,
    prev: "",
    kind: "post",
    body: { text: post.text },
    createdAt: post.createdAt,
    sig: H("ab").slice(0, 128),
  };
  const out = [written];
  if (post.retracted) {
    out.push({
      id: H("cd"),
      author: post.author,
      seq: post.seq,
      prev: H("ab"),
      kind: "retract",
      body: { target: post.id, reason: post.retractReason ?? "" },
      createdAt: post.createdAt + 60_000,
      sig: H("ef").slice(0, 128),
    });
  }
  return out;
}

const bridge: RiverBridge = {
  snapshot: async (includeSilt = false) => snapshot(includeSilt),

  publish: async (kind, body: EventBody) => {
    const nextSeq = ++seq[ME];
    const id = Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64);

    if (kind === "post") {
      const parent = body.replyTo ? posts.find((post) => post.id === body.replyTo) : null;
      posts.unshift({
        id,
        author: ME,
        text: body.text ?? "",
        replyTo: body.replyTo ?? null,
        root: body.replyTo ? (parent?.root ?? body.replyTo) : null,
        createdAt: Date.now(),
        editedAt: null,
        seq: nextSeq,
        retracted: false,
        retractReason: null,
        reactions: 0,
        replyCount: 0,
        viewerReacted: false,
        verified: true,
      });
      if (parent) parent.replyCount += 1;
    } else if (kind === "edit") {
      const target = posts.find((post) => post.id === body.target);
      if (target) {
        target.text = body.text ?? target.text;
        target.editedAt = Date.now();
      }
    } else if (kind === "retract") {
      const target = posts.find((post) => post.id === body.target);
      if (target) {
        target.retracted = true;
        target.retractReason = body.reason ?? null;
      }
    } else if (kind === "reaction") {
      const target = posts.find((post) => post.id === body.target);
      if (target) {
        target.viewerReacted = (body.emoji ?? "") !== "";
        target.reactions = Math.max(0, target.reactions + (target.viewerReacted ? 1 : -1));
      }
    } else if (kind === "follow") {
      const target = body.target ?? "";
      following = body.unfollow ? following.filter((key) => key !== target) : [...new Set([...following, target])];
    } else if (kind === "profile") {
      profiles[ME] = {
        ...profiles[ME],
        name: body.name ?? profiles[ME].name,
        bio: body.bio ?? profiles[ME].bio,
        seq: nextSeq,
      };
    }

    emit();
    return {
      id,
      author: ME,
      seq: nextSeq,
      prev: H("00"),
      kind,
      body,
      createdAt: Date.now(),
      sig: H("ff").slice(0, 128),
    };
  },

  dial: async () => ({ ok: false, error: "the browser preview cannot open sockets" }),

  peers: async () => snapshot().peers,

  verify: async () => ({
    ok: true,
    authors: 2,
    events: posts.length + 8,
    errors: [],
    checkedAt: Date.now(),
    durationMs: 11,
  }),

  breach: async (mode) => ({
    ok: false,
    authors: 1,
    events: 12,
    errors: [
      {
        author: ME,
        seq: mode === "erase" ? 2 : 3,
        code: mode === "erase" ? "gap" : "bad-signature",
        detail:
          mode === "erase"
            ? "expected seq 2, found 3 — an event is missing"
            : "signature does not cover this content",
      },
    ],
    checkedAt: Date.now(),
    durationMs: 3,
    removedSeq: mode === "erase" ? 2 : null,
  }),

  trail: async (postId) => trail(postId),

  author: async (pubkey) => {
    const authorPosts = posts.filter((post) => post.author === pubkey);
    return {
      profile: profiles[pubkey] ?? null,
      posts: authorPosts,
      events: authorPosts.map((post) => ({
        id: post.id,
        author: post.author,
        seq: post.seq,
        prev: H("00"),
        kind: "post" as const,
        body: { text: post.text },
        createdAt: post.createdAt,
        sig: H("ab").slice(0, 128),
      })),
    };
  },

  identity: async () => ({ publicKey: ME, path: "browser preview", protected: true }),
  exportKey: async () => "0".repeat(64),
  importKey: async () => ({ publicKey: ME, path: "browser preview", protected: true }),
  bootStatus: async () => ({ ok: true, error: null, identityLocked: false }),
  resetIdentity: async () => undefined,

  onUpdate: (handler) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },

  onLog: () => () => undefined,
  openExternal: () => undefined,
  versions: async () => ({ app: "0.2.0", electron: "preview", node: "preview" }),
};

if (!window.river) {
  window.river = bridge;
}
