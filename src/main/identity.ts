/**
 * Identity at rest.
 *
 * The private key is generated once, on this machine, and written to disk. When
 * the host provides an OS-backed box (Electron's safeStorage, which is DPAPI on
 * Windows and Keychain on macOS), the key is sealed with it. A headless node
 * writes plaintext and says so out loud.
 *
 * The key never crosses IPC and never enters the renderer.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPair, publicKeyOf } from "../core/crypto";

export interface KeyBox {
  seal(plain: string): Buffer;
  unseal(sealed: Buffer): string;
}

export interface Identity {
  publicKey: string;
  privateKey: string;
  path: string;
  /** true when the key is sealed by the operating system */
  protected: boolean;
}

export class IdentityLockedError extends Error {
  readonly code = "IDENTITY_LOCKED";
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(
      `The key file at ${path} could not be opened on this machine (${detail}). ` +
        `Restore it from your backup, or start a new identity — the old one stays on the network.`,
    );
    this.name = "IdentityLockedError";
  }
}

const FILE = "identity.bin";

/** Write through a temp file so a kill mid-write cannot truncate a key. */
async function writeAtomic(path: string, data: Buffer | string) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}

export async function loadOrCreateIdentity(dir: string, box: KeyBox | null): Promise<Identity> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);

  try {
    const raw = await readFile(path);
    const text = raw.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const parsed = JSON.parse(text) as { privateKey?: string };
      if (!parsed.privateKey) throw new Error("identity file has no privateKey");
      return {
        privateKey: parsed.privateKey,
        publicKey: await publicKeyOf(parsed.privateKey),
        path,
        protected: false,
      };
    }
    if (!box) {
      throw new IdentityLockedError(path, "this host provides no OS key store");
    }
    let privateKey: string;
    try {
      privateKey = box.unseal(raw);
    } catch (error) {
      throw new IdentityLockedError(path, (error as Error).message);
    }
    return { privateKey, publicKey: await publicKeyOf(privateKey), path, protected: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A key that cannot be read is never silently replaced: that would orphan
      // the whole history written under it.
      throw error;
    }
  }

  const pair = await generateKeyPair();
  if (box) {
    const sealed = box.seal(pair.privateKey);
    // Prove the seal opens before we depend on it.
    if (box.unseal(sealed) !== pair.privateKey) {
      throw new Error("the OS key store returned a key it cannot read back");
    }
    await writeAtomic(path, sealed);
  } else {
    await writeAtomic(path, JSON.stringify({ privateKey: pair.privateKey }, null, 2));
  }
  return { ...pair, path, protected: Boolean(box) };
}

export async function importIdentity(
  dir: string,
  privateKey: string,
  box: KeyBox | null,
): Promise<Identity> {
  if (!/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error("expected 64 hex characters");
  const key = privateKey.toLowerCase();
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);
  if (box) await writeAtomic(path, box.seal(key));
  else await writeAtomic(path, JSON.stringify({ privateKey: key }, null, 2));
  return { privateKey: key, publicKey: await publicKeyOf(key), path, protected: Boolean(box) };
}
