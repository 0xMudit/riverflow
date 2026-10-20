/**
 * Merkle checkpoints.
 *
 * A hash chain proves order. A Merkle root proves *content*, and a proof says
 * "this event is in that log" without handing over the whole log. That is the
 * difference between a node that has to replay an author's entire history to
 * trust it, and a node that can be handed one root and a short path.
 *
 * The tree is the same pairwise hash the rest of the project already used: two
 * children are hashed left-to-right, and an odd node is paired with itself.
 * Both the builder and the verifier here follow that rule, so a root computed
 * by one is checkable by the other.
 */
import { sha256Hex } from "./canonical";

export const ZERO_ROOT = "0".repeat(64);

export interface MerkleProof {
  /** the root the proof was made against */
  root: string;
  /** the leaf's index in the tree */
  index: number;
  /** how many leaves the tree had */
  size: number;
  /** sibling hashes, bottom level first */
  path: string[];
  /** the leaf being proven */
  leaf: string;
}

export interface Checkpoint {
  /** the author whose log this covers */
  author: string;
  /** the device chain within that author ("" is the root key) */
  device: string;
  /** the seq of the last event covered */
  seq: number;
  /** merkle root over the event ids, in chain order */
  root: string;
  /** how many events the root covers */
  count: number;
  /** when the checkpoint was made */
  at: number;
  /** the author's signature over the checkpoint */
  sig?: string;
}

/** Merkle root over an ordered list of leaves. */
export async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return ZERO_ROOT;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(left + right));
    }
    level = next;
  }
  return level[0] as string;
}

/** Build the inclusion proof for one leaf. Returns null when the index is out of range. */
export async function merkleProof(leaves: string[], index: number): Promise<MerkleProof | null> {
  if (!Array.isArray(leaves) || leaves.length === 0) return null;
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) return null;

  const tree = await levels(leaves);
  const path: string[] = [];
  let cursor = index;

  for (let depth = 0; depth < tree.length - 1; depth++) {
    const nodes = tree[depth] as string[];
    const siblingIndex = cursor % 2 === 1 ? cursor - 1 : cursor + 1;
    // An odd level pairs its last node with itself.
    path.push(nodes[siblingIndex] ?? (nodes[cursor] as string));
    cursor = Math.floor(cursor / 2);
  }

  return {
    root: tree[tree.length - 1]?.[0] as string,
    index,
    size: leaves.length,
    path,
    leaf: leaves[index] as string,
  };
}

/** Check a leaf against a proof. Never throws. */
export async function verifyMerkleProof(leaf: string, proof: MerkleProof | null): Promise<boolean> {
  if (!proof || typeof leaf !== "string" || typeof proof.root !== "string") return false;
  if (!Array.isArray(proof.path)) return false;
  if (!Number.isInteger(proof.index) || proof.index < 0) return false;

  let hash = leaf;
  let cursor = proof.index;
  try {
    for (const sibling of proof.path) {
      if (typeof sibling !== "string") return false;
      hash = cursor % 2 === 1 ? await sha256Hex(sibling + hash) : await sha256Hex(hash + sibling);
      cursor = Math.floor(cursor / 2);
    }
  } catch {
    return false;
  }
  return hash === proof.root;
}

/** The bytes a checkpoint signature covers. */
export function checkpointPayload(checkpoint: Checkpoint): string {
  return JSON.stringify({
    author: checkpoint.author,
    device: checkpoint.device,
    seq: checkpoint.seq,
    root: checkpoint.root,
    count: checkpoint.count,
    at: checkpoint.at,
  });
}

/** A checkpoint is worth nothing unless the author signed it. */
export async function verifyCheckpoint(
  checkpoint: Checkpoint,
  verifySignature: (payload: string, signature: string) => Promise<boolean>,
): Promise<boolean> {
  if (!checkpoint || typeof checkpoint.root !== "string") return false;
  if (checkpoint.count <= 0) return false;
  return verifySignature(checkpointPayload(checkpoint), checkpoint.sig ?? "");
}

async function levels(leaves: string[]): Promise<string[][]> {
  const tree: string[][] = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(left + right));
    }
    tree.push(next);
    level = next;
  }
  return tree;
}
