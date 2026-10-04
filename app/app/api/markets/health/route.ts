import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getKnownMarketLpCapitals, scanEnabledMarketLpCapitals } from "@/lib/lp-portfolio";
import { decodeMarketHealth, healthBadges, MARKET_HEALTH_SLICE_LEN, MAX_HEALTH_SLABS, parseSlabsParam } from "@/lib/market-health";
import type { MarketHealthRow } from "@/lib/market-health";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";
import { getClientIp } from "@/lib/get-client-ip";
import { recordAdlObservations } from "@/lib/adl-since-store";

/**
 * GET /api/markets/health?slabs=<a>,<b>,…  (max 50)
 *
 * v18 market health for market cards and the trade page: LP depleted, payout
 * haircut, lock reasons (lib/market-health.ts). One getMultipleAccounts with a
 * 3,675-byte dataSlice per market (header + asset slot 0) plus the LP-capital
 * lookup already used by /api/markets. Read-only; never signs.
 */
export const dynamic = "force-dynamic";

const LP_SCAN_TTL_MS = 30_000;
const RESPONSE_TTL_MS = 10_000;
// Security review LOW-1 (2026-09-30): unauthenticated RPC amplification. Per-IP
// limit + canonical (sorted, de-duplicated) cache key + an in-process response
// cache, so N distinct query strings can't force N upstream reads.
const limiter = createMemoryRateLimiter({ limit: 60, windowMs: 60_000 });
const responseCache = new Map<string, { at: number; body: { slot: number; markets: Record<string, MarketHealthRow | null> } }>();

let lpScanCache: { at: number; programId: string; map: Map<string, bigint> } | null = null;

async function lpCapitals(slabs: string[]): Promise<Map<string, bigint>> {
  const connection = getServerConnection("confirmed");
  const known = await getKnownMarketLpCapitals(connection, slabs);
  const missing = slabs.filter((s) => !known.has(s));
  if (missing.length === 0) return known;
  const programId = getConfig().programId;
  if (!lpScanCache || lpScanCache.programId !== programId || Date.now() - lpScanCache.at > LP_SCAN_TTL_MS) {
    lpScanCache = { at: Date.now(), programId, map: await scanEnabledMarketLpCapitals(connection, new PublicKey(programId)) };
  }
  for (const s of missing) {
    const c = lpScanCache.map.get(s);
    if (c != null) known.set(s, c);
  }
  return known;
}

export async function GET(req: NextRequest) {
  if (limiter.isLimited(getClientIp(req))) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  const raw = req.nextUrl.searchParams.get("slabs");
  const parsed = parseSlabsParam(raw);
  if (!parsed) {
    return NextResponse.json({ error: `slabs must be 1-${MAX_HEALTH_SLABS} comma-separated base58 addresses` }, { status: 400 });
  }
  const slabs = [...parsed].sort();
  const canonical = slabs.join(",");
  if (raw !== canonical) {
    // One cacheable URL per slab set (the client hook already requests this form).
    const url = req.nextUrl.clone();
    url.searchParams.set("slabs", canonical);
    return NextResponse.redirect(url, 308);
  }
  const cached = responseCache.get(canonical);
  if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } });
  }
  try {
    const connection = getServerConnection("confirmed");
    const programId = getConfig().programId;
    const [res, lp] = await Promise.all([
      connection.getMultipleAccountsInfoAndContext(
        slabs.map((s) => new PublicKey(s)),
        { dataSlice: { offset: 0, length: MARKET_HEALTH_SLICE_LEN }, commitment: "confirmed" },
      ),
      lpCapitals(slabs).catch(() => new Map<string, bigint>()),
    ]);
    const slot = BigInt(res.context.slot);
    const markets: Record<string, MarketHealthRow | null> = {};
    // Decode first, then look up how long each close-only market has been close-only (one durable read).
    const decoded: Record<string, ReturnType<typeof decodeMarketHealth> | null> = {};
    slabs.forEach((slab, i) => {
      const info = res.value[i];
      if (!info || info.owner.toBase58() !== programId || info.data.length < MARKET_HEALTH_SLICE_LEN) {
        decoded[slab] = null;
        return;
      }
      try {
        decoded[slab] = decodeMarketHealth(new Uint8Array(info.data), slot, lp.get(slab) ?? null);
      } catch {
        decoded[slab] = null;
      }
    });
    const adlSince = await recordAdlObservations(
      slabs.map((slab) => ({ slab, reduceOnly: decoded[slab] ? decoded[slab].lockReasons.includes("adl-reduce-only") : null })),
    ).catch(() => ({}) as Record<string, number>);
    const nowMs = Date.now();
    slabs.forEach((slab) => {
      const h = decoded[slab];
      if (!h) {
        markets[slab] = null;
        return;
      }
      try {
        const since = adlSince[slab] ?? null;
        markets[slab] = {
          lpCapital: h.lpCapital === null ? null : h.lpCapital.toString(),
          lpDepleted: h.lpDepleted,
          lpIsVault: h.lpIsVault,
          payoutHaircutBps: h.payoutHaircutBps,
          openProfitAtoms: h.openProfitAtoms.toString(),
          realizableProfitAtoms: h.realizableProfitAtoms.toString(),
          lockReasons: h.lockReasons,
          badges: healthBadges(h, since, nowMs),
          adlSinceMs: since,
        };
      } catch {
        markets[slab] = null;
      }
    });
    const body = { slot: res.context.slot, markets };
    if (responseCache.size > 500) responseCache.clear();
    responseCache.set(canonical, { at: Date.now(), body });
    return NextResponse.json(
      body,
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (e) {
    // Security review LOW-2: never echo upstream RPC error text (may carry endpoint details).
    console.error("[api/markets/health] upstream read failed:", e);
    return NextResponse.json({ error: "Market health is temporarily unavailable" }, { status: 502 });
  }
}
