/**
 * The /markets "health" column grades a market from OI, insurance and capital stats (lib/health.ts). Those
 * stats never see an ADL reduce-only market or an LP with zero capital: Agency (LP 0, winner unpaid) and SI
 * 8WC8vALs (ADL, LP 0) read "Healthy" while nobody could open a position. The live per-market health read
 * (/api/markets/health) does see them, so it overrides the stats grade.
 */
import type { HealthLevel } from "@/lib/health";
import type { MarketHealthRow } from "@/lib/market-health";

/** Badge ids for a market that is close-only until the engine itself recovers (ADL / recovery). */
const CLOSE_ONLY_BADGES: ReadonlySet<string> = new Set(["adl-reduce-only", "recovery"]);
/** Badge ids for a market with no funds on the other side: fixed by funding, so NOT "close-only". */
const NEEDS_LIQUIDITY_BADGES: ReadonlySet<string> = new Set(["lp-depleted", "lp-halted"]);

export function isCloseOnlyRow(row: MarketHealthRow | null | undefined): boolean {
  if (!row) return false;
  return row.badges.some((b) => CLOSE_ONLY_BADGES.has(b.id));
}

export function isNeedsLiquidityRow(row: MarketHealthRow | null | undefined): boolean {
  return !!row && row.badges.some((b) => NEEDS_LIQUIDITY_BADGES.has(b.id));
}

/**
 * The grade to show. A market with no price stays "oracle-down" (it has the more basic problem); an unknown
 * live read (null/undefined) never changes the stats grade, since a missing read must not look like a change.
 */
export function liveHealthLevel(base: HealthLevel, row: MarketHealthRow | null | undefined): HealthLevel {
  if (base === "oracle-down") return base;
  if (isCloseOnlyRow(row)) return "close-only";
  return isNeedsLiquidityRow(row) ? "needs-liquidity" : base;
}
