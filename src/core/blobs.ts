/**
 * Content-addressed media blobs.
 *
 * A post carries a hash and a mime type, never the bytes. The bytes live on
 * whichever peer holds them, travel in fixed-size chunks, and are checked
 * against the hash before anyone sees them. One copy of an image serves every
 * follower, and a peer that serves the wrong content gets nothing.
 */
import { fromHex, sha256Hex } from "./canonical";

export const BLOB_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const BLOB_CHUNK_BYTES = 64 * 1024; // 64 KiB
/** How many blob transfers may be open at once. */
export const BLOB_MAX_TRANSFERS = 16;
/** How long a blob transfer may stay open before it is dropped. */
export const BLOB_TRANSFER_TTL_MS = 60_000;

const HEX_HASH = /^[0-9a-f]{64}$/; // sha256, lowercase hex
const HEX_BYTES = /^[0-9a-f]*$/;
const MIDDLE_DOT = "·";
const TIMES = "×";

export interface BlobRef {
  hash: string; // sha256 hex of the bytes
  size: number; // byte length
  type: string; // mime type, e.g. "image/jpeg"
  width?: number;
  height?: number;
}

/** sha256 hex of raw bytes. */
export async function blobHash(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/** Split bytes into wire-sized chunks. Last chunk may be shorter. */
export function chunkBytes(bytes: Uint8Array, size: number = BLOB_CHUNK_BYTES): Uint8Array[] {
  const step = Math.floor(size);
  if (!Number.isFinite(step) || step <= 0) throw new Error("chunk size must be a positive number");
  if (bytes.length === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += step) {
    chunks.push(bytes.slice(offset, offset + step));
  }
  return chunks;
}

/** Inverse of chunkBytes. Throws if chunks are empty. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (!chunks || chunks.length === 0) throw new Error("no chunks to join");
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** What a chunk did to the transfer it belongs to. */
export type BlobAccept =
  | { status: "pending" }
  | { status: "complete"; bytes: Uint8Array }
  | { status: "rejected"; reason: string };

interface OpenTransfer {
  parts: Uint8Array[];
  total: number;
  bytes: number;
  at: number;
}

/**
 * Assembling a blob from the chunks a peer sends.
 *
 * A peer is not trusted with this machine's memory. The bytes are capped, the
 * number of open transfers is capped, a transfer that stalls is dropped, and a
 * peer may not change its mind about the size halfway through — a transfer
 * that never completes would otherwise sit here for ever.
 */
export class BlobTransfer {
  private readonly open = new Map<string, OpenTransfer>();

  constructor(
    private readonly maxBytes: number = BLOB_MAX_BYTES,
    private readonly maxTransfers: number = BLOB_MAX_TRANSFERS,
    private readonly ttlMs: number = BLOB_TRANSFER_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /** How many transfers are open. */
  get size(): number {
    return this.open.size;
  }

  /** Take one chunk. The blob comes back when the last chunk lands. */
  accept(hash: string, index: number, total: number, data: string): BlobAccept {
    if (typeof hash !== "string" || !HEX_HASH.test(hash)) {
      return { status: "rejected", reason: "the hash is not a sha256" };
    }
    if (!Number.isInteger(index) || index < 0) {
      return { status: "rejected", reason: "the chunk index is not a number" };
    }
    if (!Number.isInteger(total) || total <= 0) {
      return { status: "rejected", reason: "the chunk count is not a number" };
    }
    if (index >= total) {
      return { status: "rejected", reason: "the chunk is past the end" };
    }
    if (typeof data !== "string" || data.length % 2 !== 0 || !HEX_BYTES.test(data)) {
      return { status: "rejected", reason: "the chunk is not hex" };
    }

    this.prune();

    const transfer = this.open.get(hash) ?? {
      parts: [],
      total,
      bytes: 0,
      at: this.clock(),
    };

    // A peer may not change its mind about the size halfway through.
    if (transfer.total !== total) {
      this.open.delete(hash);
      return { status: "rejected", reason: "the peer changed its mind about the size" };
    }
    transfer.at = this.clock();

    if (!transfer.parts[index]) {
      // Count a chunk once, however many times it is sent.
      transfer.bytes += data.length / 2;
      if (transfer.bytes > this.maxBytes) {
        this.open.delete(hash);
        return { status: "rejected", reason: "the blob is larger than a blob may be" };
      }
    }
    transfer.parts[index] = fromHex(data);
    this.open.set(hash, transfer);

    // Every chunk must be here before the blob is whole.
    for (let position = 0; position < transfer.total; position++) {
      if (!transfer.parts[position]) return { status: "pending" };
    }

    this.open.delete(hash);
    const bytes = joinChunks(transfer.parts);
    if (bytes.length > this.maxBytes) {
      return { status: "rejected", reason: "the blob is larger than a blob may be" };
    }
    return { status: "complete", bytes };
  }

  /** Forget a transfer. */
  drop(hash: string): void {
    this.open.delete(hash);
  }

  /** Drop the transfers that have stalled, and keep the number bounded. */
  prune(): void {
    const now = this.clock();
    for (const [hash, transfer] of this.open) {
      if (now - transfer.at > this.ttlMs) this.open.delete(hash);
    }
    while (this.open.size > this.maxTransfers) {
      let oldestHash: string | null = null;
      let oldestAt = Infinity;
      for (const [hash, transfer] of this.open) {
        if (transfer.at < oldestAt) {
          oldestAt = transfer.at;
          oldestHash = hash;
        }
      }
      if (!oldestHash) break;
      this.open.delete(oldestHash);
    }
  }
}

/** True when the bytes hash to `hash`. Never throws. */
export async function verifyBlob(hash: string, bytes: Uint8Array): Promise<boolean> {
  if (typeof hash !== "string" || !HEX_HASH.test(hash)) return false;
  try {
    return (await blobHash(bytes)) === hash;
  } catch {
    return false;
  }
}

/** Type guard for a BlobRef-shaped value coming off the wire. */
export function isBlobRef(value: unknown): value is BlobRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.hash !== "string" || !HEX_HASH.test(ref.hash)) return false;
  if (typeof ref.size !== "number" || !Number.isInteger(ref.size) || ref.size < 0) return false;
  if (typeof ref.type !== "string" || ref.type.length === 0) return false;
  if (!isDimension(ref.width)) return false;
  if (!isDimension(ref.height)) return false;
  return true;
}

/** Human label for a blob, e.g. "image/jpeg · 240 kB". */
export function describeBlob(ref: BlobRef): string {
  let out = `${ref.type} ${MIDDLE_DOT} ${formatSize(ref.size)}`;
  if (typeof ref.width === "number" && typeof ref.height === "number") {
    out += ` ${MIDDLE_DOT} ${ref.width}${TIMES}${ref.height}`;
  }
  return out;
}

function isDimension(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1000) return `${Math.round(size)} B`;
  const kb = size / 1000;
  if (kb >= 100) return `${Math.round(kb)} kB`;
  return `${Math.round(kb * 10) / 10} kB`;
}
