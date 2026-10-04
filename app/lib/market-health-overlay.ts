/**
 * The /markets "health" column grades a market from OI, insurance and capital stats (lib/health.ts). Those
 * stats never see an ADL reduce-only market or an LP with zero capital: Agency (LP 0, winner unpaid) and SI
 * 8WC8vALs (ADL, LP 0) read "Healthy" while nobody could open a position. The live per-market health read
 * (/api/markets/health) does see them, so it overrides the stats grade.
 */
import type { HealthLevel } from "@/lib/health";
import type { MarketHealthRow } from "@/lib/market-health";

/** Badge ids that mean "new positions cannot open and the app cannot change that". */
const CLOSE_ONLY_BADGES: ReadonlySet<string> = new Set(["adl-reduce-only", "lp-depleted", "lp-halted", "recovery"]);

export function isCloseOnlyRow(row: MarketHealthRow | null | undefined): boolean {
  if (!row) return false;
  return row.badges.some((b) => CLOSE_ONLY_BADGES.has(b.id));
}

/**
 * The grade to show. A market with no price stays "oracle-down" (it has the more basic problem); an unknown
 * live read (null/undefined) never changes the stats grade, since a missing read must not look like a change.
 */
export function liveHealthLevel(base: HealthLevel, row: MarketHealthRow | null | undefined): HealthLevel {
  if (base === "oracle-down") return base;
  return isCloseOnlyRow(row) ? "close-only" : base;
}
