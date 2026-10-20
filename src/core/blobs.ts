/**
 * Content-addressed media blobs.
 *
 * A post carries a hash and a mime type, never the bytes. The bytes live on
 * whichever peer holds them, travel in fixed-size chunks, and are checked
 * against the hash before anyone sees them. One copy of an image serves every
 * follower, and a peer that serves the wrong content gets nothing.
 */
import { sha256Hex } from "./canonical";

export const BLOB_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const BLOB_CHUNK_BYTES = 64 * 1024; // 64 KiB

const HEX_HASH = /^[0-9a-f]{64}$/; // sha256, lowercase hex
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
