import { NextRequest, NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/config";
import { validateSlabParam } from "@/lib/route-validators";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Pyth Benchmarks — same public source /api/chart/pyth proxies for chart
 *  history. Used as the 24h-stats fallback when the indexer backend is not
 *  running (local playground, and the hosted playground deploy): without it
 *  this route 502s every 10s and 24H HIGH / 24H LOW render as dashes forever. */
const PYTH_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

type Stats24h = { change24h: number; high24h: string; low24h: string };

/** Compute 24h stats from Pyth Benchmarks hourly bars for a playground slab.
 *  Returns null when the slab has no playground meta or Pyth has no data —
 *  callers then respond `{ stats: null }` (dashes in the UI, no error spam). */
async function pythStatsFallback(slab: string): Promise<Stats24h | null> {
  const meta = PLAYGROUND_SLAB_META[slab];
  if (!meta) return null;
  // "JUP-PERP" → "Crypto.JUP/USD". Guard the base so only sane symbols reach Pyth.
  const base = meta.symbol.split("-")[0];
  if (!/^[A-Z0-9]{2,10}$/.test(base)) return null;

  const to = Math.floor(Date.now() / 1000);
  const from = to - 86_400;
  const url = `${PYTH_BASE}?symbol=${encodeURIComponent(`Crypto.${base}/USD`)}&resolution=60&from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "percolator-prices-proxy/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { s?: string; o?: number[]; h?: number[]; l?: number[]; c?: number[] };
  if (data.s !== "ok" || !data.o?.length || !data.h?.length || !data.l?.length || !data.c?.length) return null;

  const high = Math.max(...data.h);
  const low = Math.min(...data.l);
  const first = data.o[0];
  const last = data.c[data.c.length - 1];
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(first) || first <= 0) return null;

  const toE6Str = (v: number) => BigInt(Math.round(v * 1_000_000)).toString();
  return {
    change24h: ((last - first) / first) * 100,
    high24h: toE6Str(high),
    low24h: toE6Str(low),
  };
}

/**
 * GET /api/prices/[slab]
 *
 * Proxies the backend /prices/:slab endpoint and transforms the response
 * into the stats shape expected by useLivePrice.ts:
 *
 *   { stats?: { change24h?: number; high24h?: string; low24h?: string } }
 *
 * Backend returns: { prices: [{ price_e6: string, timestamp: number }] }
 * sorted descending by timestamp, up to 100 entries (oracle price history).
 *
 * We compute 24h stats from the history:
 *  - high24h / low24h: max/min price_e6 in the window
 *  - change24h: % change from oldest entry in window vs latest
 * 
 * MEDIUM-003: Added slab parameter validation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;

    // Validate slab parameter format
    const validation = validateSlabParam(slab);
    if (!validation.valid) {
      return validation.response;
    }
    const validSlab = validation.slab;

    // Primary: indexer backend oracle-price history. Absent on the local /
    // hosted playground — any failure falls through to the Pyth fallback
    // instead of 502ing (this endpoint is polled every 10s by useLivePrice).
    // getBackendUrl() THROWS when NEXT_PUBLIC_API_URL is unset (the documented
    // playground config), so it must be inside this try too.
    let prices: Array<{ price_e6: string; timestamp: number }> = [];
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/prices/${validSlab}`, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as {
          prices?: Array<{ price_e6: string; timestamp: number }>;
        };
        prices = data.prices ?? [];
      }
    } catch {
      /* backend unreachable — use the Pyth fallback below */
    }

    if (prices.length === 0) {
      const stats = await pythStatsFallback(validSlab).catch(() => null);
      return NextResponse.json({ stats }, { headers: NO_STORE });
    }

    // Prices are sorted desc (newest first). Find entries within last 24h.
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff24h = nowSec - 86_400;

    const window = prices.filter((p) => p.timestamp >= cutoff24h);
    const all = window.length > 0 ? window : prices; // fall back to all if window empty

    const values = all.map((p) => BigInt(p.price_e6));
    const latest = values[0];                              // newest (sorted desc)
    const oldest = values[values.length - 1];              // oldest in window

    let high = values[0];
    let low = values[0];
    for (const v of values) {
      if (v > high) high = v;
      if (v < low) low = v;
    }

    // change24h as percentage
    const change24h =
      oldest > 0n
        ? (Number(latest - oldest) / Number(oldest)) * 100
        : 0;

    return NextResponse.json(
      {
        stats: {
          change24h,
          high24h: high.toString(),
          low24h: low.toString(),
        },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/prices/[slab]" } });
    return NextResponse.json(
      { error: "Failed to fetch price stats" },
      { status: 502, headers: NO_STORE },
    );
  }
}
