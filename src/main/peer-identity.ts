/**
 * Peer identity: who this machine is on the network.
 *
 * The author's key says what you wrote. The peer key says who you are talking
 * to, and it is a different key for a different reason: you may want to speak
 * to the network from several machines, and you may want to drop one without
 * losing your history. The peer key is also what the DHT uses to punch
 * through a NAT, so it has a transport half as well.
 *
 * Both halves are written once and sealed with the operating system's key
 * store, exactly like the author key.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPair } from "../core/crypto";
import { fromHex, toHex } from "../core/canonical";

export interface KeyBox {
  seal(plain: string): Buffer;
  unseal(sealed: Buffer): string;
}

export interface PeerIdentity {
  /** ed25519 public key, hex. This is the peer's id on the network. */
  publicKey: string;
  /** ed25519 private key, hex. Used to sign the handshake. */
  privateKey: string;
  /** 32-byte seed for the transport keypair the DHT punches holes with. */
  transportSeed: string;
  /** where the file lives */
  path: string;
  /** true when the file is sealed by the operating system */
  protected: boolean;
}

const FILE = "peer.bin";

export async function loadOrCreatePeerIdentity(
  dir: string,
  box: KeyBox | null,
): Promise<PeerIdentity> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);

  try {
    const raw = await readFile(path);
    const text = raw.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const parsed = JSON.parse(text) as { privateKey?: string; transportSeed?: string };
      if (!parsed.privateKey || !parsed.transportSeed) {
        throw new Error("peer file is missing a key");
      }
      return {
        privateKey: parsed.privateKey,
        publicKey: await publicKeyOfPeer(parsed.privateKey),
        transportSeed: parsed.transportSeed,
        path,
        protected: false,
      };
    }
    if (!box) throw new Error("the peer key is sealed but this host has no key store");
    const plain = box.unseal(raw);
    const parsed = JSON.parse(plain) as { privateKey?: string; transportSeed?: string };
    if (!parsed.privateKey || !parsed.transportSeed) {
      throw new Error("peer file is missing a key");
    }
    return {
      privateKey: parsed.privateKey,
      publicKey: await publicKeyOfPeer(parsed.privateKey),
      transportSeed: parsed.transportSeed,
      path,
      protected: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = await generateKeyPair();
  const transportSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const payload = JSON.stringify({ privateKey: pair.privateKey, transportSeed }, null, 2);

  await writeAtomic(path, box ? box.seal(payload) : payload);
  return { ...pair, transportSeed, path, protected: Boolean(box) };
}

/** The 32 bytes of transport seed, for the DHT. */
export function transportSeedBytes(identity: PeerIdentity): Uint8Array {
  return fromHex(identity.transportSeed);
}

async function publicKeyOfPeer(privateKeyHex: string): Promise<string> {
  const { publicKeyOf } = await import("../core/crypto");
  return publicKeyOf(privateKeyHex);
}

/** Write through a temp file so a kill mid-write cannot truncate a key. */
async function writeAtomic(path: string, data: Buffer | string) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}
