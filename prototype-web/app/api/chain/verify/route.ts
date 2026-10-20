import { NextResponse } from "next/server";
import { verifyChain } from "@/lib/river/chain";
import { ledger } from "@/lib/river/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-side verification. The UI does its own, independently, on purpose. */
export async function GET() {
  const store = ledger();
  await store.load();
  const report = await verifyChain(store.snapshot());
  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}
