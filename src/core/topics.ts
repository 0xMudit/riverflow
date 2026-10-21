/**
 * Topics: how peers find each other.
 *
 * One topic for the whole network is fine until it is not: a million peers on
 * one topic is a million peers in one bucket, and the bucket is what a censor
 * or a bottleneck aims at. So the network has a global topic, which everyone
 * joins, and a set of shard topics derived from the people you follow. Two
 * nodes that follow the same person land in the same shard and find each
 * other even when the global topic is congested.
 *
 * A topic is just a 32-byte name hashed into the DHT. Nothing about you is in
 * it: the topic for an author is the hash of that author's public key.
 */
import { sha256Hex } from "./canonical";

/** The namespace every River topic lives in. */
export const NAMESPACE = "river-v1";

/** How many shard topics a node joins at once. */
export const SHARD_LIMIT = 8;

function topicBytes(label: string): Uint8Array {
  const out = new Uint8Array(32);
  const bytes = new TextEncoder().encode(label);
  out.set(bytes.slice(0, 32));
  return out;
}

/** The topic every node joins. */
export function globalTopic(): Uint8Array {
  return topicBytes(`${NAMESPACE}:all`);
}

/** The topic for one author: the nodes that follow them gather here. */
export async function authorTopic(author: string): Promise<Uint8Array> {
  const hex = await sha256Hex(`${NAMESPACE}:author:${author}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The shard topics for a set of authors, at most `limit` of them so a node
 * does not announce itself everywhere. The authors are sorted first, so two
 * nodes that follow the same people pick the same shards.
 */
export async function shardTopics(authors: string[], limit = SHARD_LIMIT): Promise<Uint8Array[]> {
  const unique = [...new Set(authors.filter(Boolean))].sort();
  const chosen = unique.slice(0, Math.max(0, limit));
  const topics: Uint8Array[] = [];
  for (const author of chosen) topics.push(await authorTopic(author));
  return topics;
}

/** The label of a topic, for the log. */
export function topicLabel(topic: Uint8Array): string {
  let out = "";
  for (const byte of topic) out += byte.toString(16).padStart(2, "0");
  return out.slice(0, 12);
}
