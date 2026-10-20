/**
 * Identity = an ed25519 keypair, generated in the browser and never uploaded.
 *
 * There is no password, no email, no recovery flow — because there is no
 * server-side account to recover. Lose the key and the identity becomes a
 * silent reader forever: its history stays on the chain, but no one can speak
 * as it again. That is the honest cost of an account nobody can take away.
 */
import * as ed from "@noble/ed25519";
import { fromHex, toBytes } from "./canonical";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey: toHex(privateKey), publicKey: toHex(publicKey) };
}

export async function publicKeyOf(privateKeyHex: string): Promise<string> {
  const pub = await ed.getPublicKeyAsync(fromHex(privateKeyHex));
  return toHex(pub);
}

export async function sign(privateKeyHex: string, message: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(message, fromHex(privateKeyHex));
  return toHex(sig);
}

export async function verify(
  publicKeyHex: string,
  message: Uint8Array | string,
  signatureHex: string,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(
      fromHex(signatureHex),
      toBytes(message),
      fromHex(publicKeyHex),
    );
  } catch {
    return false;
  }
}

/** Stable hue derived from a public key, so every identity has a colour. */
export function hueOf(publicKey: string): number {
  let acc = 0;
  for (let i = 0; i < 8; i++) {
    acc = (acc * 31 + parseInt(publicKey.slice(i * 2, i * 2 + 2), 16)) % 360;
  }
  return acc;
}
