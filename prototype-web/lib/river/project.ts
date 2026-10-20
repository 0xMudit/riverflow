/**
 * The projection: a pure fold over the chain.
 *
 * This is the whole trick. Nothing below mutates history — it *derives* the
 * present from every event ever written, in chain order. A retracted post is
 * still in the array that produced the feed; it is simply marked as silt.
 * Run this function on the same chain twice, in two different processes, and
 * you get byte-identical state. That is what makes the history trustworthy.
 */
import type { Block, RiverEvent } from "./types";

export interface Profile {
  pubkey: string;
  name: string;
  bio: string;
  hue: number;
  block: number;
  updatedAt: number;
}

export interface PostVersion {
  text: string;
  eventId: string;
  block: number;
  at: number;
}

export interface Retraction {
  eventId: string;
  block: number;
  at: number;
  reason: string | null;
}

export interface Post {
  id: string;
  author: string;
  text: string;
  replyTo: string | null;
  createdAt: number;
  block: number;
  versions: PostVersion[];
  reactions: Record<string, string>;
  retracted: Retraction | null;
  verified: boolean;
  replies: string[];
}

export interface TrailEntry {
  event: RiverEvent;
  block: number;
  seq: number;
  verified: boolean;
}

export interface RiverState {
  posts: Record<string, Post>;
  /** every post id in chain order */
  postOrder: string[];
  profiles: Record<string, Profile>;
  following: Record<string, string[]>;
  followers: Record<string, string[]>;
  /** post id -> every event that touched it, oldest first */
  trail: Record<string, TrailEntry[]>;
  /** event id -> block index */
  blockOf: Record<string, number>;
  stats: {
    blocks: number;
    events: number;
    posts: number;
    retracted: number;
    reactions: number;
    authors: number;
  };
}

export function emptyState(): RiverState {
  return {
    posts: {},
    postOrder: [],
    profiles: {},
    following: {},
    followers: {},
    trail: {},
    blockOf: {},
    stats: { blocks: 0, events: 0, posts: 0, retracted: 0, reactions: 0, authors: 0 },
  };
}

export function project(
  blocks: Block[],
  validity: Record<string, boolean> = {},
): RiverState {
  const state = emptyState();
  const followSets = new Map<string, Set<string>>();
  let seq = 0;
  let eventCount = 0;

  for (const block of blocks) {
    for (const event of block.events) {
      eventCount++;
      const verified = validity[event.id] !== false;
      state.blockOf[event.id] = block.index;

      const trailFor = (id: string): TrailEntry[] => {
        state.trail[id] ??= [];
        return state.trail[id];
      };

      switch (event.kind) {
        case "post": {
          // A replayed identical event is the same post, not a second one.
          if (state.posts[event.id]) break;
          const post: Post = {
            id: event.id,
            author: event.author,
            text: event.body.text ?? "",
            replyTo: event.body.replyTo ?? null,
            createdAt: event.createdAt,
            block: block.index,
            versions: [
              {
                text: event.body.text ?? "",
                eventId: event.id,
                block: block.index,
                at: event.createdAt,
              },
            ],
            reactions: {},
            retracted: null,
            verified,
            replies: [],
          };
          state.posts[post.id] = post;
          state.postOrder.push(post.id);
          if (post.replyTo && state.posts[post.replyTo]) {
            state.posts[post.replyTo].replies.push(post.id);
          }
          trailFor(post.id).push({ event, block: block.index, seq: seq++, verified });
          break;
        }

        case "edit": {
          const target = event.body.target ?? "";
          const post = state.posts[target];
          if (!post) break;
          // Only the author may edit, and never a retracted post.
          if (post.author !== event.author || post.retracted) break;
          post.text = event.body.text ?? post.text;
          post.versions.push({
            text: post.text,
            eventId: event.id,
            block: block.index,
            at: event.createdAt,
          });
          trailFor(target).push({ event, block: block.index, seq: seq++, verified });
          break;
        }

        case "retract": {
          const target = event.body.target ?? "";
          const post = state.posts[target];
          if (!post) break;
          if (post.author !== event.author) break;
          // The first retraction wins; later ones are still recorded in the trail.
          post.retracted ??= {
            eventId: event.id,
            block: block.index,
            at: event.createdAt,
            reason: event.body.reason ?? null,
          };
          trailFor(target).push({ event, block: block.index, seq: seq++, verified });
          break;
        }

        case "reaction": {
          const target = event.body.target ?? "";
          const post = state.posts[target];
          if (!post) break;
          const emoji = event.body.emoji ?? "";
          if (emoji === "") delete post.reactions[event.author];
          else post.reactions[event.author] = emoji;
          trailFor(target).push({ event, block: block.index, seq: seq++, verified });
          break;
        }

        case "follow": {
          const target = event.body.target ?? "";
          if (!target) break;
          const set = followSets.get(event.author) ?? new Set<string>();
          if (event.body.unfollow) set.delete(target);
          else set.add(target);
          followSets.set(event.author, set);
          break;
        }

        case "profile": {
          state.profiles[event.author] = {
            pubkey: event.author,
            name: event.body.name ?? "anon",
            bio: event.body.bio ?? "",
            hue: event.body.hue ?? 190,
            block: block.index,
            updatedAt: event.createdAt,
          };
          break;
        }
      }
    }
  }

  for (const [pubkey, set] of followSets) {
    state.following[pubkey] = [...set];
    for (const target of set) {
      state.followers[target] ??= [];
      state.followers[target].push(pubkey);
    }
  }

  const authors = new Set<string>();
  let reactions = 0;
  let retracted = 0;
  for (const post of Object.values(state.posts)) {
    authors.add(post.author);
    reactions += Object.keys(post.reactions).length;
    if (post.retracted) retracted++;
  }
  for (const profile of Object.values(state.profiles)) authors.add(profile.pubkey);

  state.stats = {
    blocks: blocks.length,
    events: eventCount,
    posts: state.postOrder.length,
    retracted,
    reactions,
    authors: authors.size,
  };

  return state;
}

export function profileOf(state: RiverState, pubkey: string): Profile {
  return (
    state.profiles[pubkey] ?? {
      pubkey,
      name: `anon:${pubkey.slice(0, 6)}`,
      bio: "",
      hue: 200,
      block: -1,
      updatedAt: 0,
    }
  );
}

export function topLevelPosts(state: RiverState): Post[] {
  return state.postOrder
    .map((id) => state.posts[id])
    .filter((post) => post && !post.replyTo);
}

export function threadOf(state: RiverState, postId: string): Post[] {
  const root = state.posts[postId];
  if (!root) return [];
  const out: Post[] = [root];
  const walk = (id: string) => {
    for (const replyId of state.posts[id]?.replies ?? []) {
      const reply = state.posts[replyId];
      if (reply) {
        out.push(reply);
        walk(replyId);
      }
    }
  };
  walk(postId);
  return out;
}
