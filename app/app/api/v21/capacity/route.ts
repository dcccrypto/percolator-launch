import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import {
  MAX_POINTS,
  downsample,
  latestPerSlab,
  parseCapacityQuery,
  toPoint,
  type CapacityPoint,
  type CapacityRowDb,
} from "@/lib/v21/capacity-snapshots";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const CACHE = { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } as const;

const COLUMNS =
  "slab,ts,slot,earn_principal_atoms,earn_nav_atoms,nav_per_share,allocated_atoms,junior_atoms,cushion_atoms,lp_equity_atoms,capacity_notional_atoms,u_long_bps,u_short_bps,max_leverage_long_x100,max_leverage_short_x100,l_ceil_x100,long_closed,short_closed,long_closed_reason,short_closed_reason,adl_active,hlock_active,draw_outstanding_atoms";

/** The slice of the Supabase builder this route uses (the generated Database type predates the table). */
interface SnapshotQueryBuilder extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  eq(col: string, v: string): SnapshotQueryBuilder;
  gte(col: string, v: string): SnapshotQueryBuilder;
  order(col: string, o: { ascending: boolean }): SnapshotQueryBuilder;
  limit(n: number): SnapshotQueryBuilder;
}
interface UntypedClient {
  from(table: string): { select(cols: string): SnapshotQueryBuilder };
}

/**
 * GET /api/v21/capacity            -> latest snapshot of every growth market (last 30 min window)
 * GET /api/v21/capacity?slab=&hours= -> one market's series, at most MAX_POINTS points
 *
 * Devnet v2.1 only: 404 unless NEXT_PUBLIC_DEVNET_V21 is on, and then no query is made. Reads with the
 * server (service-role) client, the table has RLS and no policies.
 */
export async function GET(req: NextRequest) {
  if (!isDevnetV21Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  const q = parseCapacityQuery(req.nextUrl.searchParams);
  if (!q.ok) return NextResponse.json({ error: q.error }, { status: 400, headers: NO_STORE });

  let client: UntypedClient;
  try {
    client = getServiceClient() as unknown as UntypedClient;
  } catch {
    return NextResponse.json({ error: "capacity store is not configured" }, { status: 503, headers: NO_STORE });
  }

  try {
    if (q.slab) {
      const since = new Date(Date.now() - q.hours * 3_600_000).toISOString();
      const res = await client
        .from("market_capacity_snapshots")
        .select(COLUMNS)
        .eq("slab", q.slab)
        .gte("ts", since)
        .order("ts", { ascending: true })
        .limit(5_000);
      if (res.error) throw new Error(res.error.message);
      const pts = ((res.data ?? []) as CapacityRowDb[]).map(toPoint).filter((p): p is CapacityPoint => p !== null);
      return NextResponse.json({ slab: q.slab, hours: q.hours, points: downsample(pts, MAX_POINTS) }, { headers: CACHE });
    }
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const res = await client
      .from("market_capacity_snapshots")
      .select(COLUMNS)
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(2_000);
    if (res.error) throw new Error(res.error.message);
    const latest = latestPerSlab((res.data ?? []) as CapacityRowDb[]);
    const symbols = await symbolsFor(client, latest.map((p) => p.slab));
    return NextResponse.json(
      { markets: latest.map((p) => ({ ...p, symbol: symbols.get(p.slab) ?? null })) },
      { headers: CACHE },
    );
  } catch {
    return NextResponse.json({ error: "capacity query failed" }, { status: 502, headers: NO_STORE });
  }
}

/** slab -> symbol from `markets`; any failure just means the page shows a short address. */
async function symbolsFor(client: UntypedClient, slabs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (slabs.length === 0) return out;
  try {
    const res = await client.from("markets").select("slab_address,symbol").limit(500);
    if (res.error) return out;
    const want = new Set(slabs);
    for (const r of (res.data ?? []) as Array<{ slab_address: string; symbol: string | null }>) {
      if (want.has(r.slab_address) && r.symbol) out.set(r.slab_address, r.symbol);
    }
  } catch {
    // names are cosmetic
  }
  return out;
}
