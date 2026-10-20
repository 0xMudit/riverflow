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
import type { Event, EventBody, EventKind } from "./types";

const HEX_KEY = /^[0-9a-f]{64}$/; // 32-byte public key / id
const HEX_SIG = /^[0-9a-f]{128}$/; // 64-byte ed25519 signature

export const LIMITS = {
  text: 2000,
  name: 32,
  bio: 160,
  reason: 140,
} as const;

export type EventDraft = Pick<Event, "author" | "seq" | "prev" | "kind" | "body" | "createdAt">;

export function eventPreimage(draft: EventDraft): string {
  return canonical({
    author: draft.author,
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
  if (!HEX_KEY.test(event.id) || !HEX_KEY.test(event.author) || !HEX_SIG.test(event.sig)) return false;
  const expected = await eventId(event);
  if (expected !== event.id) return false;
  return verify(event.author, fromHex(event.id), event.sig);
}

export function validateShape(event: Event, now = Date.now()): string | null {
  if (!event || typeof event !== "object") return "event is not an object";
  if (!HEX_KEY.test(event.id)) return "id must be 32-byte hex";
  if (!HEX_KEY.test(event.author)) return "author must be 32-byte hex";
  if (!HEX_SIG.test(event.sig)) return "signature must be 64-byte hex";
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
