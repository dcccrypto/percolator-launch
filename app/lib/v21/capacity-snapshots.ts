/**
 * Growth dashboard read model (pure). Rows of Supabase `market_capacity_snapshots` (written by the
 * oracle keeper, KEEPER_CAPACITY_SNAPSHOTS=1) -> the numbers the /growth page shows.
 *
 * Numeric columns arrive as strings (PostgREST `numeric`) or numbers; every conversion is defensive and
 * a bad field becomes null, never NaN on screen. Collateral is sim-USDC with 6 decimals.
 */
export const COLLATERAL_DECIMALS = 6;
const ATOMS_PER_UNIT = 10 ** COLLATERAL_DECIMALS;

/** A row as the API returns it (a subset of the table; unknown columns are ignored). */
export interface CapacityRowDb {
  slab: string;
  ts: string;
  slot?: number | string | null;
  earn_principal_atoms?: string | number | null;
  earn_nav_atoms?: string | number | null;
  nav_per_share?: string | number | null;
  allocated_atoms?: string | number | null;
  junior_atoms?: string | number | null;
  cushion_atoms?: string | number | null;
  lp_equity_atoms?: string | number | null;
  capacity_notional_atoms?: string | number | null;
  u_long_bps?: number | null;
  u_short_bps?: number | null;
  max_leverage_long_x100?: number | null;
  max_leverage_short_x100?: number | null;
  l_ceil_x100?: number | null;
  long_closed?: boolean | null;
  short_closed?: boolean | null;
  long_closed_reason?: string | null;
  short_closed_reason?: string | null;
  adl_active?: boolean | null;
  hlock_active?: boolean | null;
  draw_outstanding_atoms?: string | number | null;
}

export interface CapacityPoint {
  slab: string;
  /** Unix ms. */
  t: number;
  capacityUsd: number | null;
  lpEquityUsd: number | null;
  earnNavUsd: number | null;
  earnPrincipalUsd: number | null;
  navPerShare: number | null;
  allocatedUsd: number | null;
  juniorUsd: number | null;
  cushionUsd: number | null;
  drawOutstandingUsd: number | null;
  /** 0..1 (can exceed 1 transiently); null = unreadable. */
  utilLong: number | null;
  utilShort: number | null;
  /** Leverage multiple; 0 = that side is closed to new risk. */
  maxLevLong: number | null;
  maxLevShort: number | null;
  ceilLev: number | null;
  longClosed: boolean;
  shortClosed: boolean;
  adlActive: boolean;
  hlockActive: boolean;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const usd = (v: string | number | null | undefined): number | null => {
  const n = num(v);
  return n === null ? null : n / ATOMS_PER_UNIT;
};
const bpsToFrac = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v / 10_000 : null);
const x100 = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v / 100 : null);

/** One row -> one point, or null when the timestamp is unusable. */
export function toPoint(r: CapacityRowDb): CapacityPoint | null {
  const t = Date.parse(r.ts);
  if (!Number.isFinite(t)) return null;
  return {
    slab: r.slab,
    t,
    capacityUsd: usd(r.capacity_notional_atoms),
    lpEquityUsd: usd(r.lp_equity_atoms),
    earnNavUsd: usd(r.earn_nav_atoms),
    earnPrincipalUsd: usd(r.earn_principal_atoms),
    navPerShare: num(r.nav_per_share),
    allocatedUsd: usd(r.allocated_atoms),
    juniorUsd: usd(r.junior_atoms),
    cushionUsd: usd(r.cushion_atoms),
    drawOutstandingUsd: usd(r.draw_outstanding_atoms),
    utilLong: bpsToFrac(r.u_long_bps),
    utilShort: bpsToFrac(r.u_short_bps),
    maxLevLong: x100(r.max_leverage_long_x100),
    maxLevShort: x100(r.max_leverage_short_x100),
    ceilLev: x100(r.l_ceil_x100),
    longClosed: r.long_closed === true,
    shortClosed: r.short_closed === true,
    adlActive: r.adl_active === true,
    hlockActive: r.hlock_active === true,
  };
}

/** The newest point of each slab, in input order of first appearance. */
export function latestPerSlab(rows: ReadonlyArray<CapacityRowDb>): CapacityPoint[] {
  const best = new Map<string, CapacityPoint>();
  for (const r of rows) {
    const p = toPoint(r);
    if (!p) continue;
    const cur = best.get(p.slab);
    if (!cur || p.t > cur.t) best.set(p.slab, p);
  }
  return [...best.values()];
}

/** Evenly thin a time-ordered series to at most `max` points, always keeping the first and the last. */
export function downsample<T>(xs: ReadonlyArray<T>, max: number): T[] {
  if (max < 2 || xs.length <= max) return [...xs];
  const out: T[] = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

export const MAX_HOURS = 24 * 14;
export const DEFAULT_HOURS = 24;
export const MAX_POINTS = 400;

export type CapacityQuery = { ok: true; slab: string | null; hours: number } | { ok: false; error: string };

/** Validate `?slab=<base58>&hours=<1..336>`. */
export function parseCapacityQuery(q: URLSearchParams): CapacityQuery {
  const slab = q.get("slab");
  if (slab !== null && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slab)) return { ok: false, error: "invalid slab" };
  const h = q.get("hours");
  let hours = DEFAULT_HOURS;
  if (h !== null) {
    const n = Number(h);
    if (!Number.isInteger(n) || n < 1 || n > MAX_HOURS) return { ok: false, error: `hours must be an integer in [1, ${MAX_HOURS}]` };
    hours = n;
  }
  return { ok: true, slab, hours };
}

/** Plain-language state of one side for the table. */
export function sideLabel(maxLev: number | null, closed: boolean): string {
  if (closed) return "closed";
  if (maxLev === null) return "unknown";
  return `${maxLev.toFixed(maxLev >= 10 ? 0 : 1)}x`;
}
