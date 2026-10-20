/**
 * The data key: the one secret that seals everything the node keeps.
 *
 * It is generated once, on this machine, and sealed with the operating
 * system's key store — the same way the identity key is. Lose it and the local
 * copy of the ledger is unreadable; the history itself still lives on the
 * network, and the identity key is what lets you sign for it again.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { KeyBox } from "./identity";

const FILE = "data-key.bin";

export async function loadOrCreateDataKey(dir: string, box: KeyBox | null): Promise<Buffer> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);

  try {
    const raw = await readFile(path);
    const text = raw.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const parsed = JSON.parse(text) as { key?: string };
      if (!parsed.key) throw new Error("data key file has no key");
      return Buffer.from(parsed.key, "base64");
    }
    if (!box) throw new Error("the data key is sealed but this host has no key store");
    return Buffer.from(box.unseal(raw), "base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(32);
  if (box) {
    const sealed = box.seal(key.toString("base64"));
    // Prove the seal opens before anything is written under it.
    if (box.unseal(sealed) !== key.toString("base64")) {
      throw new Error("the OS key store returned a key it cannot read back");
    }
    await writeAtomic(path, sealed);
  } else {
    await writeAtomic(path, JSON.stringify({ key: key.toString("base64") }, null, 2));
  }
  return key;
}

/** Write through a temp file so a kill mid-write cannot truncate a key. */
async function writeAtomic(path: string, data: Buffer | string) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
}
