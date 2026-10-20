import { NextResponse } from "next/server";
import { validateEventShape, verifyEvent } from "@/lib/river/events";
import { project } from "@/lib/river/project";
import { checkReferences } from "@/lib/river/rules";
import { ledger } from "@/lib/river/store";
import type { RiverEvent } from "@/lib/river/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The only write endpoint in the entire application.
 *
 * It appends. It has no sibling that updates, and none that deletes. Every
 * "destructive" action in the product is just another event posted here.
 */
export async function POST(request: Request) {
  let payload: { event?: RiverEvent };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const event = payload.event;
  if (!event) {
    return NextResponse.json({ error: "missing event" }, { status: 400 });
  }

  const shapeError = validateEventShape(event);
  if (shapeError) {
    return NextResponse.json({ error: shapeError }, { status: 400 });
  }

  if (!(await verifyEvent(event))) {
    return NextResponse.json(
      { error: "signature does not match this event and author" },
      { status: 400 },
    );
  }

  const store = ledger();
  await store.load();

  const state = project(store.snapshot());
  const referenceError = checkReferences(state, event);
  if (referenceError) {
    return NextResponse.json({ error: referenceError }, { status: 409 });
  }

  const block = await store.append([event]);

  return NextResponse.json(
    {
      ok: true,
      event: event.id,
      block: { index: block.index, hash: block.hash, nonce: block.nonce },
      head: store.head().hash,
      height: store.height,
    },
    { status: 201 },
  );
}
