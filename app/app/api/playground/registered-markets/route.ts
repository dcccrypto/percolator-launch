/**
 * GET /api/playground/registered-markets
 *
 * Public read of the playground's dynamically-registered markets (Vercel Blob
 * backed — see lib/playground-registered-markets.ts). The oracle keeper used to
 * poll this endpoint to discover wizard-created markets; the live relaunch keeper
 * (percolator-oracle-keeper relaunch, src/cross-cluster/register-poll.ts) now reads
 * the Supabase `markets` table (keeper_status='active') instead. In-app, the Earn
 * page seeds from it (hooks/useEarnStats.ts).
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
 *      that has been deleted stops being served without having to be named;
 *   3. (GH#2988) a slab confirmed dead is dropped: either the RPC returned an
 *      explicit `null` (never existed / garbage-collected), or the account is
 *      the wrapper-owned closed-market TOMBSTONE. CloseSlab does NOT delete the
 *      slab (wrapper 553d76f0 handle_close_slab: realloc to 16 bytes, stamp
 *      KIND_CLOSED_MARKET, keep the rent, stay owned by the wrapper), so a
 *      closed market is never `null` — see lib/closed-market-tombstone.ts. An
 *      RPC failure, a short reply, an unparseable account or a read in which NO
 *      slab exists (wrong cluster) proves nothing and drops nothing — see
 *      readSlabExistence in lib/live-market-state.ts.
 *
 * KEEPER: the live relaunch keeper's register-poll sources its list from the
 * Supabase `markets` table (REGISTER_SOURCE_URL is legacy/log-only), so this
 * endpoint's contents do not drive it. A keeper that does consume the list
 * retires an absent entry only after ABSENCE_THRESHOLD consecutive absences and
 * refuses a 0-market wipe, so dropping a closed market is safe.
 *
 * The DB is the authority for what exists; the Blob only supplies the extra fields
 * the keeper needs that the DB does not carry (dexType, poolAddress). If the DB is
 * unreachable the blocklist filter still applies and the Blob set is served —
 * degrading to "slightly stale" rather than "keeper prices nothing".
 */
import { NextResponse } from "next/server";
import { readRegisteredMarketsChecked } from "@/lib/playground-registered-markets";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { readSlabExistence } from "@/lib/live-market-state";

export const dynamic = "force-dynamic";

/**
 * Review E5: this route is unauthenticated and uncached, so every caller paid a Supabase read. The
 * DB slab set is shared for REGISTERED_MARKETS_DB_MEMO_MS (default 3 s) with in-flight dedupe: a
 * flood costs one read per 3 s per instance, and a just-registered market is delayed by at most
 * that (the keeper polls every 30 s). A failed read (null) is not kept. The response stays no-store.
 */
let slabMemo: { at: number; set: Set<string> } | null = null;
let slabInflight: Promise<Set<string> | null> | null = null;

function slabMemoMs(): number {
  const v = Number(process.env.REGISTERED_MARKETS_DB_MEMO_MS ?? 3_000);
  return Number.isFinite(v) && v >= 0 ? v : 3_000;
}

async function liveSlabAddresses(): Promise<Set<string> | null> {
  const ttl = slabMemoMs();
  if (ttl === 0) return readLiveSlabAddresses();
  const now = Date.now();
  if (slabMemo && now - slabMemo.at < ttl) return slabMemo.set;
  if (slabInflight) return slabInflight;
  const p = readLiveSlabAddresses()
    .then((set) => {
      if (set !== null) slabMemo = { at: now, set };
      return set;
    })
    .finally(() => {
      if (slabInflight === p) slabInflight = null;
    });
  slabInflight = p;
  return p;
}

/**
 * Slabs the database currently knows about, or null when it cannot be read.
 * Null means "skip this filter" — see the degradation note above.
 */
async function readLiveSlabAddresses(): Promise<Set<string> | null> {
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
  // A failed store read still answers 200 with what it has (the previous snapshot, or none), but
  // says so: `complete: false` lets a reader that sums over the list (the Earn TVL) not treat a
  // partial list as the whole one. Readers that ignore the field are unaffected.
  const { markets: all, ok: readOk } = await readRegisteredMarketsChecked();
  const notBlocked = all.filter((m) => !BLOCKED_SLAB_ADDRESSES.has(m.slabAddress));

  const live = await liveSlabAddresses();

  const dbFiltered = live === null ? notBlocked : notBlocked.filter((m) => live.has(m.slabAddress));

  // GH#2988: drop only slabs confirmed dead (null, or the closed-market tombstone). Existence-only probe
  // (17-byte dataSlice), so this costs ~no slab bytes; RPC/parse uncertainty keeps the fail-open policy.
  const chain = await readSlabExistence(dbFiltered.map((m) => m.slabAddress));
  const markets = dbFiltered.filter((m) => !chain.missing.has(m.slabAddress));

  return NextResponse.json(
    readOk ? { markets } : { markets, complete: false },
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
        // The cost is at most one Supabase read per 3 s per instance (the DB slab
        // set is memoized server-side, see liveSlabAddresses), a single indexed
        // select of one column.
        "Cache-Control": "no-store, max-age=0, must-revalidate",
      },
    },
  );
}
