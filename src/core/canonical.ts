/**
 * Deterministic serialisation + hashing.
 *
 * A signature only means something if both sides hash the same bytes, so the
 * canonical form is: keys sorted, no whitespace, undefined dropped. Identical
 * in the renderer and in Node because both expose WebCrypto.
 */

export const ZERO_HASH = "0".repeat(64);

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = sortValue(source[key]);
  }
  return out;
}

const encoder = new TextEncoder();

export function toBytes(input: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof input === "string") return encoder.encode(input);
  // Copy into a fresh ArrayBuffer so the BufferSource type is unambiguous.
  return new Uint8Array(input);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(input));
  return toHex(new Uint8Array(digest));
}

/** Standard pairwise merkle root. Used to fingerprint a log slice cheaply. */
export async function merkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return ZERO_HASH;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}
