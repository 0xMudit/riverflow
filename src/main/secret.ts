/**
 * Sealing at rest.
 *
 * The private key was always sealed by the operating system. The words were
 * not: the posts sat in a SQLite file that anybody with the disk could read.
 * This closes that gap. Every piece of text the node keeps — event bodies,
 * post text, names, retraction reasons, notification snippets — is encrypted
 * with a key that never leaves the keychain, before it touches the disk.
 *
 * The ledger's structure stays in the clear on purpose: who wrote, when, and
 * how many events there are. That is what makes the log indexable and
 * verifiable. The content is not.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from("R1");

/**
 * Encrypt a string. The context travels inside the envelope and is bound
 * into the ciphertext as additional authenticated data, so a sealed body
 * cannot be moved into another column and read back as something it is not.
 */
export function sealText(key: Uint8Array, text: string, context: string): string {
  const label = Buffer.from(context, "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(label);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const envelope = Buffer.concat([
    MAGIC,
    Buffer.from([label.length]),
    label,
    iv,
    cipher.getAuthTag(),
    body,
  ]);
  return envelope.toString("base64");
}

/** True when a value is already a sealed envelope rather than plain text. */
export function isSealed(value: string): boolean {
  if (!value || !value.startsWith("UjE")) return false;
  try {
    const raw = Buffer.from(value, "base64");
    return raw.length > MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC);
  } catch {
    return false;
  }
}

/** Decrypt a string. Returns "" for anything that does not open. */
export function openText(key: Uint8Array, sealed: string): string {
  if (!sealed) return "";
  let raw: Buffer;
  try {
    raw = Buffer.from(sealed, "base64");
  } catch {
    return "";
  }
  if (raw.length < MAGIC.length + 1) return "";

  const labelLength = raw[MAGIC.length] as number;
  const labelStart = MAGIC.length + 1;
  const labelEnd = labelStart + labelLength;
  if (raw.length < labelEnd + IV_BYTES + TAG_BYTES) return "";

  const label = raw.subarray(labelStart, labelEnd);
  const iv = raw.subarray(labelEnd, labelEnd + IV_BYTES);
  const tag = raw.subarray(labelEnd + IV_BYTES, labelEnd + IV_BYTES + TAG_BYTES);
  const body = raw.subarray(labelEnd + IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(label);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
