/**
 * Events — the only thing a client may create.
 *
 * An event is content-addressed: its id is the hash of what it says, including
 * its position in the author's log. Change a byte, a seq, or the previous link
 * and the id changes, the signature no longer covers it, and every later event
 * in that log loses its parent. This is why a post cannot be quietly rewritten.
 */
import { canonical, fromHex, sha256Hex, ZERO_HASH } from "./canonical";
import { sign, verify } from "./crypto";
import { ETH_ADDRESS, signatureBytes, verifyPersonalSignature } from "./eth";
import type { Event, EventBody, EventKind } from "./types";

const HEX_KEY = /^[0-9a-f]{64}$/; // 32-byte public key / id
const HEX_SIG = /^[0-9a-f]{128}$/; // 64-byte ed25519 signature
const HEX_SIG_ETH = /^[0-9a-f]{130}$/; // 65-byte secp256k1 signature

export const LIMITS = {
  text: 2000,
  name: 32,
  bio: 160,
  reason: 140,
} as const;

export type EventDraft = Pick<
  Event,
  "author" | "device" | "scheme" | "seq" | "prev" | "kind" | "body" | "createdAt"
>;

export function eventPreimage(draft: EventDraft): string {
  return canonical({
    author: draft.author,
    // The device is part of the identity of the event: the same words signed by
    // a phone and a laptop are two different events, not one rewritten event.
    ...(draft.device ? { device: draft.device } : {}),
    // The scheme is part of it too, but only when it is not the default, so an
    // event written before wallets existed keeps the id it always had.
    ...(draft.scheme && draft.scheme !== "ed25519" ? { scheme: draft.scheme } : {}),
    seq: draft.seq,
    prev: draft.prev,
    kind: draft.kind,
    body: draft.body,
    createdAt: draft.createdAt,
  });
}

export async function eventId(draft: EventDraft): Promise<string> {
  return sha256Hex(eventPreimage(draft));
}

export async function createEvent(
  privateKeyHex: string,
  draft: Omit<EventDraft, "createdAt">,
  createdAt = Date.now(),
): Promise<Event> {
  const full: EventDraft = { ...draft, createdAt };
  const id = await eventId(full);
  const sig = await sign(privateKeyHex, fromHex(id));
  return { ...full, id, sig };
}

/** Recompute the id and check the signature. Pure and offline. */
export async function verifyEvent(event: Event): Promise<boolean> {
  if (!event || typeof event !== "object") return false;
  if (!HEX_KEY.test(event.id)) return false;
  if (event.device !== undefined && event.device !== "" && !HEX_KEY.test(event.device)) return false;

  const expected = await eventId(event);
  if (expected !== event.id) return false;

  if (event.scheme === "eth") {
    // A wallet signs the id with personal_sign; the address that recovers is
    // the author, so the wallet cannot write as anybody else.
    if (!ETH_ADDRESS.test(event.author)) return false;
    if (!HEX_SIG_ETH.test(event.sig)) return false;
    return verifyPersonalSignature(
      event.author,
      fromHex(event.id),
      signatureBytes(event.sig),
    );
  }

  if (!HEX_KEY.test(event.author) || !HEX_SIG.test(event.sig)) return false;
  // A delegated device signs for the person, not for itself.
  const signer = event.device || event.author;
  return verify(signer, fromHex(event.id), event.sig);
}

export function validateShape(event: Event, now = Date.now()): string | null {
  if (!event || typeof event !== "object") return "event is not an object";
  if (!HEX_KEY.test(event.id)) return "id must be 32-byte hex";
  if (event.scheme === "eth") {
    if (!ETH_ADDRESS.test(event.author)) return "author must be an address";
    if (!HEX_SIG_ETH.test(event.sig)) return "signature must be 65 bytes";
  } else {
    if (!HEX_KEY.test(event.author)) return "author must be 32-byte hex";
    if (!HEX_SIG.test(event.sig)) return "signature must be 64-byte hex";
  }
  if (event.scheme !== undefined && event.scheme !== "ed25519" && event.scheme !== "eth") {
    return "unknown signature scheme";
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) return "seq must be a non-negative integer";
  if (event.seq === 0 ? event.prev !== "" : !HEX_KEY.test(event.prev)) {
    return "prev must be empty at seq 0 and a hash afterwards";
  }
  if (!Number.isFinite(event.createdAt)) return "createdAt must be a number";
  if (event.createdAt > now + 10 * 60 * 1000) return "createdAt is in the future";

  const body = event.body ?? {};
  switch (event.kind) {
    case "post": {
      if (typeof body.text !== "string" || body.text.trim().length === 0) return "post needs text";
      if (body.text.length > LIMITS.text) return `post exceeds ${LIMITS.text} characters`;
      if (body.replyTo !== undefined && !HEX_KEY.test(body.replyTo)) return "replyTo must be an event id";
      return null;
    }
    case "edit": {
      if (!HEX_KEY.test(body.target ?? "")) return "edit needs a target";
      if (typeof body.text !== "string" || body.text.trim().length === 0) return "edit needs text";
      if (body.text.length > LIMITS.text) return `edit exceeds ${LIMITS.text} characters`;
      return null;
    }
    case "retract": {
      if (!HEX_KEY.test(body.target ?? "")) return "retract needs a target";
      if (body.reason !== undefined && body.reason.length > LIMITS.reason) return "reason too long";
      return null;
    }
    case "reaction": {
      if (!HEX_KEY.test(body.target ?? "")) return "reaction needs a target";
      if (typeof body.emoji !== "string" || [...body.emoji].length > 2) return "emoji is invalid";
      return null;
    }
    case "follow": {
      if (!HEX_KEY.test(body.target ?? "")) return "follow needs a target";
      if (body.target === event.author) return "cannot follow yourself";
      return null;
    }
    case "profile": {
      if (typeof body.name !== "string" || body.name.trim().length === 0) return "profile needs a name";
      if (body.name.length > LIMITS.name) return "name too long";
      if (body.bio !== undefined && body.bio.length > LIMITS.bio) return "bio too long";
      if (body.hue !== undefined && (!Number.isInteger(body.hue) || body.hue < 0 || body.hue > 359)) {
        return "hue must be 0..359";
      }
      return null;
    }
    case "device": {
      if (!HEX_KEY.test(body.device ?? "")) return "device needs the key it authorises";
      if (body.device === event.author) return "the root key needs no authorisation";
      if (event.device) return "a device cannot authorise another device";
      if (body.name !== undefined && body.name.length > LIMITS.name) return "device name too long";
      if (body.revoked !== undefined && typeof body.revoked !== "boolean") {
        return "revoked must be true or false";
      }
      return null;
    }
    case "dm": {
      // The words are not here to check: only the envelope is. It must be
      // addressed to a real key, sealed for somebody else, and small enough
      // that a peer cannot use one message to fill our disk.
      if (!HEX_KEY.test(body.to ?? "")) return "dm needs a recipient key";
      if (body.to === event.author) return "cannot message yourself";
      if (!isEnvelope(body.sealed)) return "dm needs a sealed envelope";
      if (body.sealed.length > MAX_ENVELOPE) return "dm envelope is too large";
      if (body.copy !== undefined && !isEnvelope(body.copy)) return "dm copy is not an envelope";
      if (event.device) return "a device cannot send a direct message";
      return null;
    }
    default:
      return "unknown event kind";
  }
}

/** Text is stored as plain text and escaped at render. Strip control chars. */
export function cleanText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

export { ZERO_HASH };
