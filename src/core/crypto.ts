/**
 * Identity = an ed25519 keypair.
 *
 * The private key never leaves the node process, and is sealed with the OS
 * keychain (see main/identity.ts). Lose it and this identity becomes a silent
 * reader forever: its history stays on the network, but nobody can speak as it
 * again. That is the honest cost of an account no one can revoke.
 */
import * as ed from "@noble/ed25519";
import { fromHex, toBytes, toHex } from "./canonical";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey: toHex(privateKey), publicKey: toHex(publicKey) };
}

export async function publicKeyOf(privateKeyHex: string): Promise<string> {
  return toHex(await ed.getPublicKeyAsync(fromHex(privateKeyHex)));
}

export async function sign(privateKeyHex: string, message: Uint8Array): Promise<string> {
  return toHex(await ed.signAsync(message, fromHex(privateKeyHex)));
}

export async function verify(
  publicKeyHex: string,
  message: Uint8Array | string,
  signatureHex: string,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(fromHex(signatureHex), toBytes(message), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

/** Stable hue derived from a public key, so every identity has a colour. */
export function hueOf(publicKey: string): number {
  let acc = 0;
  for (let i = 0; i < 8; i++) {
    acc = (acc * 31 + Number.parseInt(publicKey.slice(i * 2, i * 2 + 2), 16)) % 360;
  }
  return acc;
}
