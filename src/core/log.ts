/**
 * Log verification.
 *
 * Independent of storage, so the same function can check a database, a file a
 * friend sent you, or a deliberately damaged copy. A log is valid when it
 * starts at seq 0, every event points at the one before it, and every
 * signature matches its author.
 */
import { verifyEvent } from "./events";
import type { Event } from "./types";

export interface LogError {
  author: string;
  seq: number;
  code: "gap" | "broken-link" | "bad-signature" | "bad-shape";
  detail: string;
}

export async function verifyLog(events: Event[]): Promise<LogError[]> {
  const errors: LogError[] = [];
  let expectedPrev = "";

  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      errors.push({
        author: event.author,
        seq: event.seq,
        code: "gap",
        detail: `expected seq ${index}, found ${event.seq} — ${index === 0 ? "log does not start at 0" : "an event is missing"}`,
      });
      break;
    }
    if (event.prev !== expectedPrev) {
      errors.push({
        author: event.author,
        seq: event.seq,
        code: "broken-link",
        detail: "prev does not match the event before it",
      });
      break;
    }
    if (!(await verifyEvent(event))) {
      errors.push({
        author: event.author,
        seq: event.seq,
        code: "bad-signature",
        detail: "signature does not cover this content",
      });
      break;
    }
    expectedPrev = event.id;
  }

  return errors;
}
