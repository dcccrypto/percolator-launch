/**
 * GET /api/chart/pyth?symbol=Crypto.SOL/USD&resolution=60&from=<unix>&to=<unix>
 *
 * Proxy to Pyth Benchmarks — free, public, TradingView-compatible OHLCV bars
 * for any Pyth feed. Canonical underlying-asset price data (same source all
 * Solana perp DEXes use for their chart history), so the chart shows real
 * SOL/USD history from second zero instead of waiting 24h for our own
 * keeper-observed oracle ticks to accumulate.
 *
 * Response format (TradingView UDF):
 *   { s: "ok", t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }
 *
 * We normalise to our CandleData shape and cache server-side for 60s.
 */

import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PYTH_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

// Whitelist the symbols we actually support — prevents arbitrary fetches.
const ALLOWED_SYMBOLS = new Set<string>([
  "Crypto.SOL/USD",
  "Crypto.BTC/USD",
  "Crypto.ETH/USD",
  "Crypto.JUP/USD",
  "Crypto.JTO/USD",
  "Crypto.WIF/USD",
  "Crypto.BONK/USD",
  "Crypto.PYTH/USD",
]);

// Pyth accepts: 1, 5, 15, 30, 60, 240, D, W, M
const ALLOWED_RESOLUTIONS = new Set<string>(["1", "5", "15", "30", "60", "240", "D", "W", "M"]);

export interface PythCandleData {
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const resolution = url.searchParams.get("resolution") ?? "60";
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return NextResponse.json({ error: `Unsupported symbol: ${symbol}` }, { status: 400 });
  }
  if (!ALLOWED_RESOLUTIONS.has(resolution)) {
    return NextResponse.json({ error: `Unsupported resolution: ${resolution}` }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const to = toStr ? parseInt(toStr, 10) : now;
  const from = fromStr ? parseInt(fromStr, 10) : to - 7 * 86400; // default 7 days
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
  }
  if (to - from > 5 * 365 * 86400) {
    return NextResponse.json({ error: "Range too large (max 5 years)" }, { status: 400 });
  }

  const upstream = `${PYTH_BASE}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}`;

  try {
    const res = await fetch(upstream, {
      headers: { "User-Agent": "percolator-chart-proxy/1.0" },
      // 10s upstream timeout via AbortController
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Pyth upstream ${res.status}` },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const data: {
      s?: string;
      t?: number[];
      o?: number[];
      h?: number[];
      l?: number[];
      c?: number[];
      v?: number[];
    } = await res.json();

    if (data.s !== "ok" || !data.t || !data.o || !data.h || !data.l || !data.c) {
      return NextResponse.json(
        { candles: [], empty: true },
        { status: 200, headers: { "Cache-Control": "public, s-maxage=30" } },
      );
    }

    const candles: PythCandleData[] = data.t.map((ts: number, i: number) => ({
      timestamp: ts * 1000, // Pyth is unix seconds; convert to ms
      open: data.o![i],
      high: data.h![i],
      low: data.l![i],
      close: data.c![i],
      volume: (data.v?.[i] ?? 0),
    }));

    return NextResponse.json(
      { candles, symbol, resolution, from, to },
      { status: 200, headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Pyth fetch failed: ${msg}` }, { status: 502 });
  }
}
