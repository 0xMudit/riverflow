/**
 * Events: the only thing a client is allowed to create.
 *
 * An event is content-addressed. Its id is the hash of what it says, and the
 * signature covers that id. So the id cannot be swapped, the body cannot be
 * edited, and the author cannot be forged — a changed byte produces a
 * different, unsigned id.
 */
import { canonical, fromHex, sha256Hex, ZERO_HASH } from "./canonical";
import { sign, verify } from "./crypto";
import type { EventBody, EventKind, RiverEvent } from "./types";

const HEX64 = /^[0-9a-f]{64}$/;

export const LIMITS = {
  text: 1000,
  name: 32,
  bio: 160,
  reason: 140,
} as const;

export type DraftEvent = Pick<RiverEvent, "author" | "kind" | "body" | "createdAt">;

export function eventPreimage(draft: DraftEvent): string {
  return canonical({
    author: draft.author,
    kind: draft.kind,
    body: draft.body,
    createdAt: draft.createdAt,
  });
}

export async function eventId(draft: DraftEvent): Promise<string> {
  return sha256Hex(eventPreimage(draft));
}

/** Sign an event with a private key. Returns the finished, chainable event. */
export async function createEvent(
  privateKeyHex: string,
  author: string,
  kind: EventKind,
  body: EventBody,
  createdAt = Date.now(),
): Promise<RiverEvent> {
  const draft: DraftEvent = { author, kind, body, createdAt };
  const id = await eventId(draft);
  const sig = await sign(privateKeyHex, fromHex(id));
  return { id, author, kind, body, createdAt, sig };
}

/** Recompute the id and check the signature. Pure, offline, no trust. */
export async function verifyEvent(event: RiverEvent): Promise<boolean> {
  if (!event || typeof event !== "object") return false;
  if (!HEX64.test(event.id) || !HEX64.test(event.author) || !HEX64.test(event.sig)) {
    return false;
  }
  const expected = await eventId({
    author: event.author,
    kind: event.kind,
    body: event.body,
    createdAt: event.createdAt,
  });
  if (expected !== event.id) return false;
  return verify(event.author, fromHex(event.id), event.sig);
}

/** Structural + semantic validation. Applied before an event may enter a block. */
export function validateEventShape(event: RiverEvent, now = Date.now()): string | null {
  if (!event || typeof event !== "object") return "event is not an object";
  if (!HEX64.test(event.id)) return "id must be 32-byte hex";
  if (!HEX64.test(event.author)) return "author must be 32-byte hex";
  if (!HEX64.test(event.sig)) return "signature must be 64-byte hex";
  if (ZERO_HASH === event.author) return "author cannot be zero key";
  if (!Number.isFinite(event.createdAt)) return "createdAt must be a number";
  if (event.createdAt > now + 5 * 60 * 1000) return "createdAt is in the future";

  const body = event.body ?? {};
  switch (event.kind) {
    case "post": {
      if (typeof body.text !== "string" || body.text.trim().length === 0) return "post needs text";
      if (body.text.length > LIMITS.text) return `post exceeds ${LIMITS.text} chars`;
      if (body.replyTo !== undefined && !HEX64.test(body.replyTo)) return "replyTo must be an event id";
      return null;
    }
    case "edit": {
      if (!HEX64.test(body.target ?? "")) return "edit needs a target";
      if (typeof body.text !== "string" || body.text.trim().length === 0) return "edit needs text";
      if (body.text.length > LIMITS.text) return `edit exceeds ${LIMITS.text} chars`;
      return null;
    }
    case "retract": {
      if (!HEX64.test(body.target ?? "")) return "retract needs a target";
      if (body.reason !== undefined && body.reason.length > LIMITS.reason) return "reason too long";
      return null;
    }
    case "reaction": {
      if (!HEX64.test(body.target ?? "")) return "reaction needs a target";
      if (typeof body.emoji !== "string" || [...body.emoji].length > 2) return "emoji is invalid";
      return null;
    }
    case "follow": {
      if (!HEX64.test(body.target ?? "")) return "follow needs a target";
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
      return `unknown event kind: ${(event as RiverEvent).kind}`;
  }
}

/** Text travels as plain text and is escaped at render. Strip control chars. */
export function cleanText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}
