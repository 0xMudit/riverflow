/**
 * Wallets: the other kind of key.
 *
 * River's own key is ed25519, sealed in the operating system. But people have
 * keys they already carry — in MetaMask, in Rabby, in a hardware wallet, in a
 * seed phrase they wrote down. This is the scheme that lets one of those keys
 * be an author too, without River depending on anybody's company: any wallet
 * that speaks EIP-1193 and signs with secp256k1 works, and a wallet is
 * optional.
 *
 * The signing is EIP-191 `personal_sign`: the wallet signs the 32-byte id of
 * the event, the signature is 65 bytes, and the author is the address that
 * signature recovers to. The id is still sha256 over the canonical event, so
 * the ledger has one shape and two kinds of signer.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, toHex, toBytes } from "./canonical";

/** An Ethereum-style address: 0x and forty hex characters. */
export const ETH_ADDRESS = /^0x[0-9a-f]{40}$/i;

const PERSONAL_PREFIX = "\x19Ethereum Signed Message:\n";

/** keccak256, the hash Ethereum uses. */
export function keccak256(input: Uint8Array): Uint8Array {
  return keccak_256(input);
}

/** The bytes a wallet actually signs for a personal_sign of `message`. */
export function personalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${PERSONAL_PREFIX}${message.length}`);
  const both = new Uint8Array(prefix.length + message.length);
  both.set(prefix, 0);
  both.set(message, prefix.length);
  return keccak256(both);
}

/** The address of a public key: the last twenty bytes of its keccak hash. */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  const raw = publicKey.length === 65 ? publicKey.subarray(1) : publicKey;
  return `0x${toHex(keccak256(raw).subarray(12))}`;
}

/**
 * The addresses that a signature could have been made by.
 *
 * A secp256k1 signature has up to four candidate public keys; only one of
 * them is the signer's. The claimed address picks the right one, so a
 * verifier tries them all and asks which one matches.
 */
function recoverCandidates(digest: Uint8Array, signature: Uint8Array): string[] {
  const compact = compactSignature(signature);
  if (!compact) return [];
  const found: string[] = [];
  for (let candidate = 0; candidate < 4; candidate++) {
    try {
      const parsed = secp256k1.Signature.fromBytes(compact, "compact");
      const withBit = parsed.addRecoveryBit(candidate);
      const address = addressFromPublicKey(withBit.recoverPublicKey(digest).toBytes(false));
      if (!found.includes(address)) found.push(address);
    } catch {
      /* this candidate does not lift to a key */
    }
  }
  return found;
}

/**
 * The address that signed a digest, or null when the signature does not
 * recover. The signature is r || s || v, with v as 27 or 28.
 */
export function recoverAddress(digest: Uint8Array, signature: Uint8Array): string | null {
  return recoverCandidates(digest, signature)[0] ?? null;
}

/** Check a personal_sign against the address that claims to have made it. */
export function verifyPersonalSignature(
  address: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!ETH_ADDRESS.test(address)) return false;
  const wanted = address.toLowerCase();
  return recoverCandidates(personalSignDigest(message), signature).includes(wanted);
}

/**
 * The r and s of a signature, without the recovery byte.
 *
 * Wallets send r || s || v, with v as 27 or 28 (some send 0 or 1). The v is
 * only a hint: a verifier tries every candidate key and asks which one
 * matches the address that claims to have signed.
 */
function compactSignature(signature: Uint8Array): Uint8Array | null {
  if (signature.length === 64) return signature;
  if (signature.length === 65) return signature.subarray(0, 64);
  return null;
}

/** The bytes of a hex signature, or an empty array when it is not hex. */
export function signatureBytes(hex: string): Uint8Array {
  try {
    // Wallets write 0x in front; some do not.
    const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    return fromHex(clean);
  } catch {
    return new Uint8Array(0);
  }
}

// ---------------------------------------------------------------- sign in

export interface SiweMessage {
  /** the place the sign-in is for */
  domain: string;
  /** the address signing in */
  address: string;
  /** what the person is agreeing to */
  statement?: string;
  /** where they are, for the record */
  uri?: string;
  /** a one-shot nonce, so a signature can never be replayed */
  nonce: string;
  /** when the challenge was made */
  issuedAt?: string;
}

/**
 * The sign-in statement, in the shape wallets already know: a domain, an
 * address, a sentence, and a nonce that only works once.
 */
export function formatSiwe(message: SiweMessage): string {
  const lines = [
    `${message.domain} wants you to sign in with your wallet:`,
    message.address,
    "",
    message.statement ?? "Sign in to River.",
    "",
    `URI: ${message.uri ?? message.domain}`,
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt ?? new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

/** Check a sign-in statement against the signature that came with it. */
export function verifySiwe(
  text: string,
  signature: Uint8Array,
): { address: string; nonce: string } | null {
  const address = text.split("\n")[1]?.trim() ?? "";
  const nonce = /Nonce:\s*(\S+)/.exec(text)?.[1] ?? "";
  if (!ETH_ADDRESS.test(address) || !nonce) return null;
  if (!verifyPersonalSignature(address, toBytes(text), signature)) return null;
  return { address: address.toLowerCase(), nonce };
}
