/**
 * Explicit, simulation-sized compute-unit limits for trade / close / batch transactions.
 *
 * P1 final report: CPI trades cost ~13k CU more, and a single-leg BatchTradeCpi on asset 1 used
 * 216,269 CU — over the 200k default a transaction gets without a ComputeBudget instruction.
 * Every such tx must set a limit; a limit sized from simulation keeps the priority fee (charged
 * per requested CU) honest instead of paying for a flat 600k-800k.
 *
 *   limit = consumed * (1 + marginBps / 1e4) + padUnits, clamped to [minUnits, cap]
 *   - `cap` is the sane default ceiling (400k per leg) AND the fallback when simulation is
 *     unavailable or fails (the real error then surfaces through sendTx's own simulation);
 *   - if the simulated need is ABOVE `cap`, the limit follows the need (never past the 1.4M
 *     transaction maximum) — a tx sized below what it demonstrably uses would only fail.
 */
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const MAX_TX_COMPUTE_UNITS = 1_400_000;
export const CU_PER_LEG_CAP = 400_000;
// Live 2026-10-01 (PERC add, sig 632JyLFS…): simulated ~248k, landed needing >290k (+17%) — the
// engine accrues/refreshes in-tx when the slot moves between the sizing simulation and landing,
// so +15% / 5k ran out of CU (ProgramFailedToComplete). +30% / 50k covers that drift.
export const DEFAULT_CU_MARGIN_BPS = 3_000; // +30%
export const DEFAULT_CU_PAD = 50_000;
export const DEFAULT_CU_MIN = 50_000;

export interface CuSizing {
  cap: number;
  marginBps?: number;
  padUnits?: number;
  minUnits?: number;
}

/** Cap for an n-leg trade / close / batch: 400k per leg, within the tx maximum. */
export function tradeCuCap(legs: number): number {
  return Math.min(MAX_TX_COMPUTE_UNITS, CU_PER_LEG_CAP * Math.max(1, Math.floor(legs)));
}

export function sizeComputeUnitLimit(consumed: number | null | undefined, s: CuSizing): number {
  const cap = Math.min(MAX_TX_COMPUTE_UNITS, Math.max(1, Math.floor(s.cap)));
  if (consumed === null || consumed === undefined || !Number.isFinite(consumed) || consumed <= 0) return cap;
  const margin = s.marginBps ?? DEFAULT_CU_MARGIN_BPS;
  const want = Math.ceil((consumed * (10_000 + margin)) / 10_000) + (s.padUnits ?? DEFAULT_CU_PAD);
  const floor = s.minUnits ?? DEFAULT_CU_MIN;
  const sized = Math.max(floor, want);
  if (sized <= cap) return sized;
  return Math.min(MAX_TX_COMPUTE_UNITS, sized);
}

/**
 * v2.2 QA A-3: the floor of every SIGNED limit on a v2.2 build. A band market's simulated cost is not a bound on its
 * landed cost: the swordcat close simulated ~367k (limit 1.3x + 50k = 527,696) and landed needing 527,222+ of it
 * (ProgramFailedToComplete, tx 46xL2VCt…); its retry simulated ~582k and landed at 525k. Measured v2.2 single-trade
 * txs: open 364-396k, close 525-542k, crank + refresh + close 702k. 800k clears all of them; the cost is only the
 * priority fee on the requested units. Flag off: unchanged.
 */
export const V22_MIN_SIGNED_CU = 800_000;

/** The limit to SIGN: sizeComputeUnitLimit, raised to V22_MIN_SIGNED_CU on a v2.2 build, never past 1.4M. */
export function signedComputeUnitLimit(consumed: number | null | undefined, s: CuSizing, v22: boolean = isDevnetV22Enabled()): number {
  const n = sizeComputeUnitLimit(consumed, s);
  return v22 ? Math.min(MAX_TX_COMPUTE_UNITS, Math.max(n, V22_MIN_SIGNED_CU)) : n;
}
