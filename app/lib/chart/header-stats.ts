/**
 * Pure helpers for the perp chart's header strip: 24h change, compact USD, funding and OI/volume
 * rows from the existing routes. No I/O, no React.
 */
import { rowVolumeUsd } from "@/lib/q-usd";

export interface HourBar { timeSec: number; open: number; close: number }

export interface Change24h {
  /** Percent, e.g. 3.2 for +3.2%. */
  pct: number;
  /** True when the series has under ~23 h of history, so the figure is "since the first bar". */
  partial: boolean;
}

/**
 * 24h change from hourly bars (ascending): the close of the last bar at or before now-24h is the
 * reference; with less history than that, the first bar's open (flagged partial).
 */
export function change24h(hourly: readonly HourBar[], current: number | null, nowSec: number): Change24h | null {
  if (current === null || !(current > 0) || hourly.length === 0) return null;
  const cutoff = nowSec - 86_400;
  let ref: number | null = null;
  for (const b of hourly) { if (b.timeSec <= cutoff && b.close > 0) ref = b.close; else if (b.timeSec > cutoff) break; }
  let partial = false;
  if (ref === null) {
    ref = hourly[0].open > 0 ? hourly[0].open : null;
    partial = true;
  }
  if (ref === null || !(ref > 0)) return null;
  return { pct: ((current - ref) / ref) * 100, partial };
}

export function formatCompactUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(0)}`;
  return a === 0 ? "$0" : `$${v.toFixed(2)}`;
}

export function formatPct(p: number | null | undefined, digits = 2): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p > 0 ? "+" : ""}${p.toFixed(digits)}%`;
}

export interface FundingView {
  /** Hourly-equivalent rate in percent. */
  hourlyPct: number;
  /** True when the engine can apply funding on this market at all. */
  enabled: boolean;
}

/** /api/funding/[slab] -> view. A 404 (rate not decodable) is `null` upstream; this only parses a 200 body. */
export function parseFunding(body: unknown): FundingView | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { hourlyRatePercent?: unknown; fundingEnabled?: unknown };
  const h = Number(b.hourlyRatePercent);
  if (!Number.isFinite(h)) return null;
  return { hourlyPct: h, enabled: b.fundingEnabled === true };
}

export interface MarketRowStats { volume24hUsd: number | null; oiUsd: number | null }

/** The row for `slab` in the /api/markets list body. */
export function marketRowStats(body: unknown, slab: string): MarketRowStats | null {
  if (typeof body !== "object" || body === null) return null;
  const list = (body as { markets?: unknown }).markets;
  if (!Array.isArray(list)) return null;
  const row = list.find((r): r is Record<string, unknown> => typeof r === "object" && r !== null && (r as { slab_address?: unknown }).slab_address === slab);
  if (!row) return null;
  const oi = Number(row.total_open_interest_usd);
  return {
    volume24hUsd: rowVolumeUsd(row as { volume_24h?: number | null; volume_24h_usd?: number | null; last_price?: number | null }),
    oiUsd: Number.isFinite(oi) ? oi : null,
  };
}
