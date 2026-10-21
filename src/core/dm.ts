/**
 * Direct messages — sealed so only the person they are for can read them.
 *
 * A message is an ordinary event on its author's chain: signed with the same
 * key as a post, sequenced in the same log, relayed by the same gossip. What
 * differs is the body: the words are never in it. They travel as a sealed
 * envelope addressed to the recipient's identity key.
 *
 * The construction is ECIES over X25519:
 *
 *   1. convert the recipient's ed25519 public key to its X25519 equivalent
 *      (the birational map — a person keeps one key, not two),
 *   2. make a throwaway X25519 keypair for this one message,
 *   3. derive a shared secret, mix both public keys into an HKDF salt,
 *   4. encrypt the words with AES-256-GCM under that key.
 *
 * Whoever relays the event sees only ciphertext. The recipient's node opens it
 * with the identity key it already has. There is no separate chat key to leak,
 * no plaintext on disk, and no server that could be asked for a copy.
 *
 * The sender keeps a copy too — sealed to their own key, in the same body — so
 * a conversation is readable from either side without trusting the other party
 * to still have it.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "./canonical";

/** What a sealed envelope starts with. Refuse anything else. */
const VERSION = "rv1";

/** Bounds the ciphertext a peer can make us buffer for one message. */
export const MAX_ENVELOPE = 20_000;

const INFO = new TextEncoder().encode("river-dm-v1");
const AAD = new TextEncoder().encode("river-dm-envelope-v1");

// ------------------------------------------------------------- encodings

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --------------------------------------------------------------- sealing

/**
 * The X25519 key that belongs to an ed25519 identity.
 *
 * A person has one public key. Deriving the Montgomery form of it is a curve
 * conversion, not a second identity: the private half is derived the same way
 * from the one private key, so no extra material is ever stored.
 */
function toMontgomeryPublic(ed25519PublicHex: string): Uint8Array {
  return ed25519.utils.toMontgomery(fromHex(ed25519PublicHex));
}

function toMontgomerySecret(ed25519PrivateHex: string): Uint8Array {
  return ed25519.utils.toMontgomerySecret(fromHex(ed25519PrivateHex));
}

async function deriveKey(
  shared: Uint8Array,
  ephemeral: Uint8Array,
  recipient: Uint8Array,
): Promise<CryptoKey> {
  // Both public keys in the salt bind the key to this exact pair, so a
  // ciphertext cannot be replayed at a different recipient.
  const salt = new Uint8Array(ephemeral.length + recipient.length);
  salt.set(ephemeral, 0);
  salt.set(recipient, ephemeral.length);
  const raw = hkdf(sha256, shared, salt, INFO, 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal words so only `recipientPublicKey` can open them. */
export async function sealDm(
  recipientPublicKey: string,
  senderPrivateKey: string,
  text: string,
): Promise<string> {
  const recipient = toMontgomeryPublic(recipientPublicKey);
  const ephemeral = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeral);
  const shared = x25519.getSharedSecret(ephemeral, recipient);
  const key = await deriveKey(shared, ephemeralPublic, recipient);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: AAD },
      key,
      new TextEncoder().encode(text),
    ),
  );
  return [
    VERSION,
    toHex(ephemeralPublic),
    toBase64Url(iv),
    toBase64Url(ciphertext),
  ].join(".");
}

/**
 * Open an envelope addressed to us. Returns null for anything we cannot read:
 * a message for somebody else, a tampered ciphertext, or a version we do not
 * know. A DM the user cannot read is not an error worth crashing a sync for.
 */
export async function openDm(
  envelope: string,
  recipientPrivateKey: string,
): Promise<string | null> {
  try {
    if (typeof envelope !== "string" || envelope.length > MAX_ENVELOPE) return null;
    const [version, ephemeralHex, ivText, cipherText] = envelope.split(".");
    if (version !== VERSION || !ephemeralHex || !ivText || !cipherText) return null;
    if (!/^[0-9a-f]{64}$/.test(ephemeralHex)) return null;

    const ephemeralPublic = fromHex(ephemeralHex);
    const secret = toMontgomerySecret(recipientPrivateKey);
    const recipientPublic = x25519.getPublicKey(secret);
    const shared = x25519.getSharedSecret(secret, ephemeralPublic);
    const key = await deriveKey(shared, ephemeralPublic, recipientPublic);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivText), additionalData: AAD },
      key,
      fromBase64Url(cipherText),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Does this look like an envelope at all? Cheap check for ingest bounds. */
export function isEnvelope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ENVELOPE &&
    value.startsWith(`${VERSION}.`)
  );
}
