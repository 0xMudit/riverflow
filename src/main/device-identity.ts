/**
 * The device key: the key this machine writes with.
 *
 * The identity key is the person. A device key is one of their machines, and
 * the person signs a `device` event naming it. After that the machine writes
 * into its own chain, so a phone and a laptop never fork one history, and a
 * machine that is stolen can be revoked without touching the past.
 *
 * The key is generated on this machine and sealed with the operating system,
 * like every other secret River keeps.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPair } from "../core/crypto";
import type { KeyBox } from "./identity";

export interface DeviceIdentity {
  publicKey: string;
  privateKey: string;
  path: string;
  protected: boolean;
}

const FILE = "device.bin";

export async function loadOrCreateDeviceIdentity(
  dir: string,
  box: KeyBox | null,
): Promise<DeviceIdentity> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);

  try {
    const raw = await readFile(path);
    const text = raw.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const parsed = JSON.parse(text) as { privateKey?: string };
      if (!parsed.privateKey) throw new Error("device file has no privateKey");
      const { publicKeyOf } = await import("../core/crypto");
      return {
        privateKey: parsed.privateKey,
        publicKey: await publicKeyOf(parsed.privateKey),
        path,
        protected: false,
      };
    }
    if (!box) throw new Error("the device key is sealed but this host has no key store");
    const plain = box.unseal(raw);
    const parsed = JSON.parse(plain) as { privateKey?: string };
    if (!parsed.privateKey) throw new Error("device file has no privateKey");
    const { publicKeyOf } = await import("../core/crypto");
    return {
      privateKey: parsed.privateKey,
      publicKey: await publicKeyOf(parsed.privateKey),
      path,
      protected: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = await generateKeyPair();
  const payload = JSON.stringify({ privateKey: pair.privateKey }, null, 2);
  await writeAtomic(path, box ? box.seal(payload) : payload);
  return { ...pair, path, protected: Boolean(box) };
}

/** Write through a temp file so a kill mid-write cannot truncate a key. */
async function writeAtomic(path: string, data: Buffer | string) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}
