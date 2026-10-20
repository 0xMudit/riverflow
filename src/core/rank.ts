/**
 * Local ranking: the "for you" feed, computed on this machine.
 *
 * There is no server and no profile of the viewer, so the order of a feed
 * follows from the follow graph and the clock the caller hands in. The same
 * inputs always give the same order, which is what makes it testable.
 * Nothing here reads the system clock or asks for randomness.
 */

/** How fast interest decays: half of a post's weight is gone after this long. */
export const HALF_LIFE_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Posts older than this are not ranked, only shown in chronological order. */
export const RANK_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const AFFINITY_SELF = 1.6;
const AFFINITY_FOLLOWED = 1;
const AFFINITY_STRANGER = 0.35;
const INTERACTION_BOOST = 1.25;
const REACTION_WEIGHT = 0.15;
const REPLY_WEIGHT = 0.25;
const SCORE_PRECISION = 1e6;

export interface RankCandidate {
  id: string;
  author: string;
  createdAt: number;
  replyCount: number;
  reactions: number;
  retracted: boolean;
  /** true when the viewer replied to or reacted to this post */
  interacted: boolean;
}

export interface RankContext {
  /** fixed clock in ms — never read the system clock inside scoring */
  now: number;
  /** authors the viewer follows */
  following: ReadonlySet<string>;
  /** the viewer's own author key */
  me: string;
  /** authors the viewer muted or blocked — excluded entirely */
  muted: ReadonlySet<string>;
}

export interface RankedPost extends RankCandidate {
  score: number;
}

/** Score one candidate. Higher is better. */
export function scorePost(candidate: RankCandidate, ctx: RankContext): number {
  const post = candidate as RankCandidate | undefined;
  if (!post) return 0;
  const context = (ctx as RankContext | undefined) ?? NO_CONTEXT;

  const now = finite(context.now);
  const createdAt = finite(post.createdAt);
  const reactions = Math.max(0, finite(post.reactions));
  const replies = Math.max(0, finite(post.replyCount));

  const ageMs = Math.max(0, now - createdAt);
  const freshness = 0.5 ** (ageMs / HALF_LIFE_MS);
  const engagement =
    1 + Math.log2(1 + reactions) * REACTION_WEIGHT + Math.log2(1 + replies) * REPLY_WEIGHT;
  const boost = post.interacted ? INTERACTION_BOOST : 1;
  const affinity = affinityOf(post.author, context);

  return round6(affinity * freshness * engagement * boost);
}

/**
 * Rank a list. Returns a new array sorted by score descending.
 * Ties break by createdAt descending, then by id ascending (stable, deterministic).
 */
export function rankFeed(candidates: RankCandidate[], ctx: RankContext): RankedPost[] {
  const context = (ctx as RankContext | undefined) ?? NO_CONTEXT;
  const list = (candidates as RankCandidate[] | undefined) ?? [];
  const ranked: RankedPost[] = [];

  for (const candidate of list) {
    if (!candidate) continue;
    if (contains(context.muted, candidate.author)) continue;
    if (candidate.retracted) continue;
    ranked.push({ ...candidate, score: scorePost(candidate, context) });
  }

  ranked.sort(byScoreThenTime);
  return ranked;
}

/**
 * The chronological feed: newest first, ties by id ascending.
 * Muted and blocked authors are still excluded.
 */
export function chronologicalFeed(candidates: RankCandidate[], ctx: RankContext): RankCandidate[] {
  const context = (ctx as RankContext | undefined) ?? NO_CONTEXT;
  const list = (candidates as RankCandidate[] | undefined) ?? [];
  const feed: RankCandidate[] = [];

  for (const candidate of list) {
    if (!candidate) continue;
    if (contains(context.muted, candidate.author)) continue;
    feed.push({ ...candidate });
  }

  feed.sort(byTimeThenId);
  return feed;
}

const NO_CONTEXT: RankContext = {
  now: 0,
  following: new Set<string>(),
  me: "",
  muted: new Set<string>(),
};

function affinityOf(author: string, ctx: RankContext): number {
  if (author === ctx.me) return AFFINITY_SELF;
  if (contains(ctx.following, author)) return AFFINITY_FOLLOWED;
  return AFFINITY_STRANGER;
}

function contains(set: ReadonlySet<string> | undefined, key: string): boolean {
  return set ? set.has(key) : false;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round6(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function byScoreThenTime(a: RankedPost, b: RankedPost): number {
  if (a.score !== b.score) return b.score - a.score;
  const time = finite(b.createdAt) - finite(a.createdAt);
  if (time !== 0) return time;
  return byId(a.id, b.id);
}

function byTimeThenId(a: RankCandidate, b: RankCandidate): number {
  const time = finite(b.createdAt) - finite(a.createdAt);
  if (time !== 0) return time;
  return byId(a.id, b.id);
}

function byId(a: string, b: string): number {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
