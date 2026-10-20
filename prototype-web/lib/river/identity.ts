"use client";

/**
 * Keys live in localStorage and never leave the browser. Signing happens here;
 * the server only ever receives a finished signature to check.
 */
import { generateKeyPair, publicKeyOf, type KeyPair } from "./crypto";

const STORAGE_KEY = "river.key.v1";

export interface Identity extends KeyPair {
  createdAt: number;
}

function read(): Identity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    if (!parsed.privateKey || !parsed.publicKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(identity: Identity): Identity {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  window.dispatchEvent(new Event("river:identity"));
  return identity;
}

export async function ensureIdentity(): Promise<Identity> {
  const existing = read();
  if (existing) {
    const derived = await publicKeyOf(existing.privateKey);
    // Guard against a hand-edited key that no longer matches its public half.
    if (derived !== existing.publicKey) {
      return write({ ...existing, publicKey: derived });
    }
    return existing;
  }
  const pair = await generateKeyPair();
  return write({ ...pair, createdAt: Date.now() });
}

export function currentIdentity(): Identity | null {
  return read();
}

export async function importIdentity(payload: string): Promise<Identity> {
  const parsed = JSON.parse(payload) as Partial<Identity>;
  if (!parsed.privateKey || !/^[0-9a-f]{64}$/i.test(parsed.privateKey)) {
    throw new Error("That does not look like a River key (expected 64 hex characters).");
  }
  const publicKey = await publicKeyOf(parsed.privateKey.toLowerCase());
  return write({
    privateKey: parsed.privateKey.toLowerCase(),
    publicKey,
    createdAt: parsed.createdAt ?? Date.now(),
  });
}

export function forgetIdentity(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("river:identity"));
}

export function exportIdentity(identity: Identity): string {
  return JSON.stringify(
    {
      app: "river",
      note: "This private key is the account. Anyone holding it can speak as you. There is no reset.",
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAt: identity.createdAt,
    },
    null,
    2,
  );
}
