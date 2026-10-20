import { NextResponse } from "next/server";
import { difficulty } from "@/lib/river/chain";
import { ledger } from "@/lib/river/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole ledger, every block, every signature. No pagination and no
 * filtering: a client that can only see part of the chain cannot verify it.
 */
export async function GET() {
  const store = ledger();
  await store.load();
  const blocks = store.snapshot();

  return NextResponse.json(
    {
      blocks,
      height: blocks.length - 1,
      difficulty: difficulty(),
      head: blocks[blocks.length - 1]?.hash ?? null,
    },
    {
      headers: {
        // Never serve a cached ledger; the client must see the real head.
        "cache-control": "no-store",
      },
    },
  );
}
