/**
 * GET /api/playground/registered-markets
 *
 * Public read of the playground's dynamically-registered markets (Vercel Blob
 * backed — see lib/playground-registered-markets.ts). This is the endpoint the
 * oracle keeper polls outbound (percolator-oracle-keeper/src/cross-cluster/
 * register-poll.ts) to discover markets created through the create-market wizard
 * after the keeper process started.
 *
 * No secrets in the payload — public read is intentional so the NAT'd keeper can
 * reach it with a plain unauthenticated GET.
 */
import { NextResponse } from "next/server";
import { readRegisteredMarkets } from "@/lib/playground-registered-markets";

export const dynamic = "force-dynamic";

export async function GET() {
  const markets = await readRegisteredMarkets();
  return NextResponse.json({ markets });
}
