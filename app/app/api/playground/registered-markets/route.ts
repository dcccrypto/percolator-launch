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
 *
 * RETIREMENT FILTER (2026-07-29)
 * ------------------------------
 * The Blob is append-only: a market registered by the wizard stays in it forever.
 * That made the keeper the last place a retired market survived — it kept pushing
 * AUTH_MARK prices to slabs long after they were blocklisted in the UI and deleted
 * from the database, and clearing its local registry.json did NOT help, because
 * this endpoint handed them straight back on its next 30s poll.
 *
 * So the payload is filtered here, at the source the keeper already polls, rather
 * than by teaching the keeper a second blocklist it would then have to keep in
 * sync:
 *
 *   1. blocklisted slabs are dropped outright;
 *   2. what remains is intersected with the live `markets` table, so a market
 *      that has been deleted stops being served without having to be named.
 *
 * The DB is the authority for what exists; the Blob only supplies the extra fields
 * the keeper needs that the DB does not carry (dexType, poolAddress). If the DB is
 * unreachable the blocklist filter still applies and the Blob set is served —
 * degrading to "slightly stale" rather than "keeper prices nothing".
 */
import { NextResponse } from "next/server";
import { readRegisteredMarkets } from "@/lib/playground-registered-markets";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Slabs the database currently knows about, or null when it cannot be read.
 * Null means "skip this filter" — see the degradation note above.
 */
async function liveSlabAddresses(): Promise<Set<string> | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("markets")
      .select("slab_address")
      .eq("network", getServerNetwork());
    if (error || !data) return null;
    return new Set(
      (data as Array<{ slab_address: string | null }>)
        .map((r) => r.slab_address)
        .filter((s): s is string => !!s),
    );
  } catch {
    return null; // Supabase not configured (local playground) — skip this filter.
  }
}

export async function GET() {
  const all = await readRegisteredMarkets();
  const notBlocked = all.filter((m) => !BLOCKED_SLAB_ADDRESSES.has(m.slabAddress));

  const live = await liveSlabAddresses();
  const markets = live === null ? notBlocked : notBlocked.filter((m) => live.has(m.slabAddress));

  return NextResponse.json(
    { markets },
    {
      headers: {
        // NO CACHE. This is a liveness feed, not a page.
        //
        // The keeper polls it to learn about markets that did not exist when it
        // booted, so any edge cache is added latency on the one thing that has
        // to be immediate: a market the user just created must be priced now,
        // not up to s-maxage seconds from now. A stale-while-revalidate window
        // is worse still — it serves the pre-launch answer while refreshing.
        //
        // The cost is one Supabase read per poll, which is a single indexed
        // select over a table with a handful of rows.
        "Cache-Control": "no-store, max-age=0, must-revalidate",
      },
    },
  );
}
