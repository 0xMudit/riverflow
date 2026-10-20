/**
 * Blocks, proof of work, and chain verification.
 *
 * A block commits to three things at once: its position (index + prevHash),
 * its contents (merkleRoot over the event ids) and the work spent on it
 * (nonce, difficulty). Change any byte anywhere and every hash after it stops
 * matching — which is exactly why nothing can be quietly removed.
 */
import { canonical, merkleRoot, sha256Hex, ZERO_HASH } from "./canonical";
import { validateEventShape, verifyEvent } from "./events";
import type { Block, ChainError, RiverEvent, VerificationReport } from "./types";

export const GENESIS_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
export const MAX_MINING_ATTEMPTS = 60_000_000;

export function difficulty(): number {
  const raw = Number(process.env.RIVER_DIFFICULTY ?? 3);
  if (!Number.isInteger(raw) || raw < 1 || raw > 6) return 3;
  return raw;
}

function header(block: Omit<Block, "hash">) {
  return {
    index: block.index,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    difficulty: block.difficulty,
    nonce: block.nonce,
    merkleRoot: block.merkleRoot,
  };
}

export async function blockHash(block: Omit<Block, "hash">): Promise<string> {
  return sha256Hex(canonical(header(block)));
}

export function meetsDifficulty(hash: string, difficulty: number): boolean {
  return hash.startsWith("0".repeat(difficulty));
}

export async function genesisBlock(): Promise<Block> {
  const draft = {
    index: 0,
    prevHash: ZERO_HASH,
    timestamp: GENESIS_TIME,
    difficulty: 1,
    nonce: 0,
    events: [] as RiverEvent[],
    merkleRoot: ZERO_HASH,
  };
  return { ...draft, hash: await blockHash(draft) };
}

/** Mine one block containing exactly these events. */
export async function mineBlock(
  prev: Block,
  events: RiverEvent[],
  powDifficulty = difficulty(),
  timestamp = Date.now(),
): Promise<Block> {
  const draft = {
    index: prev.index + 1,
    prevHash: prev.hash,
    timestamp,
    difficulty: powDifficulty,
    nonce: 0,
    events,
    merkleRoot: await merkleRoot(events.map((e) => e.id)),
  };

  const target = "0".repeat(powDifficulty);
  for (let attempt = 0; attempt < MAX_MINING_ATTEMPTS; attempt++) {
    draft.nonce = attempt;
    const hash = await blockHash(draft);
    if (hash.startsWith(target)) {
      return { ...draft, hash };
    }
  }
  throw new Error("mining exceeded attempt cap — lower RIVER_DIFFICULTY");
}

export interface VerifyOptions {
  /** skip ed25519 checks for a fast structural pass (still checks hashes) */
  skipSignatures?: boolean;
  /** shared cache of already-verified event ids, to keep polling cheap */
  cache?: Map<string, boolean>;
}

/**
 * Verify everything, from genesis, with no trust in the server that sent it.
 * Returns per-event validity too, so the UI can flag a forged event instead of
 * pretending it is real.
 */
export async function verifyChain(
  blocks: Block[],
  options: VerifyOptions = {},
): Promise<VerificationReport> {
  const errors: ChainError[] = [];
  const eventValidity: Record<string, boolean> = {};
  let eventCount = 0;

  if (blocks.length === 0) {
    errors.push({ code: "bad-index", block: 0, detail: "chain is empty" });
    return { ok: false, height: 0, events: 0, errors, eventValidity, checkedAt: Date.now() };
  }

  const genesis = await genesisBlock();
  const head = blocks[0];
  if (head.index !== 0) {
    errors.push({ code: "bad-index", block: 0, detail: "first block is not genesis" });
  }
  if (head.hash !== genesis.hash) {
    errors.push({ code: "bad-hash", block: 0, detail: "genesis hash does not match" });
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block.index !== i) {
      errors.push({
        code: "bad-index",
        block: i,
        detail: `expected index ${i}, found ${block.index}`,
      });
    }

    if (i > 0 && block.prevHash !== blocks[i - 1].hash) {
      errors.push({
        code: "broken-link",
        block: i,
        detail: `prevHash does not match block ${i - 1}`,
      });
    }

    const recomputed = await blockHash(block);
    if (recomputed !== block.hash) {
      errors.push({
        code: "bad-hash",
        block: i,
        detail: `hash ${block.hash.slice(0, 10)}… should be ${recomputed.slice(0, 10)}…`,
      });
    }

    const root = await merkleRoot(block.events.map((e) => e.id));
    if (root !== block.merkleRoot) {
      errors.push({ code: "bad-merkle", block: i, detail: "merkle root mismatch" });
    }

    if (i > 0 && !meetsDifficulty(block.hash, block.difficulty)) {
      errors.push({
        code: "insufficient-work",
        block: i,
        detail: `hash does not meet difficulty ${block.difficulty}`,
      });
    }

    for (const event of block.events) {
      eventCount++;
      const shapeError = validateEventShape(event, Number.POSITIVE_INFINITY);
      if (shapeError) {
        errors.push({ code: "bad-event", block: i, detail: `${event.id.slice(0, 8)}: ${shapeError}` });
        eventValidity[event.id] = false;
        continue;
      }
      let valid = options.cache?.get(event.id);
      if (valid === undefined) {
        valid = options.skipSignatures ? true : await verifyEvent(event);
        options.cache?.set(event.id, valid);
      }
      eventValidity[event.id] = valid;
      if (!valid) {
        errors.push({
          code: "bad-signature",
          block: i,
          detail: `event ${event.id.slice(0, 8)} is not signed by its author`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    height: blocks.length - 1,
    events: eventCount,
    errors,
    eventValidity,
    checkedAt: Date.now(),
  };
}

/** Cheap structural fingerprint used to detect a rewritten ledger file. */
export async function chainHeadHash(blocks: Block[]): Promise<string> {
  return blocks.length ? blocks[blocks.length - 1].hash : ZERO_HASH;
}
