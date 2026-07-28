/**
 * market-params.ts — derives every risk parameter a new market needs from the
 * ONLY two things a creator chooses: leverage and the fee split.
 *
 * Why this file exists
 * ───────────────────
 * The launch wizard used to hardcode `maxPriceMoveBpsPerSlot: 1` and disable
 * the LP guardrails (`maxFillAbs`/`maxInventoryAbs` at i128::MAX,
 * `skewSpreadMultBps: 0`). Both were verified on devnet (2026-07-27) to be
 * actively harmful:
 *
 * (`impactKBps: 0` used to be listed here too. It is NOT a missing guardrail:
 * impact is vAMM-only. `compute_passive_execution` in percolator-match/src/vamm.rs
 * prices off `base_spread_bps + trading_fee_bps + skew_extra` and never reads
 * `impact_k_bps`, and the impact term zeroes out anyway when
 * `liquidity_notional_e6` is 0. These markets are `kind: 0` (Passive), so 0 is
 * the correct value — do not "fix" it.)
 *
 *  1. A price move freezes NEW positions for as long as the settlement price
 *     lags the oracle. At 1 bps/slot a 26% move froze a market for ~17 minutes.
 *     Proven causally: a converged market opens fine; push -30% and the same
 *     trader is refused `Custom(21)` until the gap closes.
 *
 *  2. With no impact, no fill cap, no inventory cap and no skew, the LP is a
 *     free unlimited counterparty. Any directionally-correct trader drains it —
 *     which is exactly how the Jimothy market died (LP at $0, -$2,479).
 *
 * These are written ONCE at market creation and can never be changed: the
 * matcher has no update instruction, and `max_price_move_bps_per_slot` lives in
 * the engine config. Getting them wrong is permanent for that market, which is
 * why they are derived here rather than typed in by a creator.
 *
 * The solvency envelope (the reason this is a trade-off, not a free win)
 * ─────────────────────────────────────────────────────────────────────
 * The engine rejects InitMarket unless the per-slot price-move budget fits
 * inside what maintenance margin can absorb (`validate_exact_solvency_envelope`,
 * percolator/src/v16.rs). That rate limit is a SOLVENCY GUARANTEE: it is what
 * stops a price move outrunning liquidation. So faster convergence costs
 * liquidation headroom, and higher leverage (thinner margin) buys LESS of it.
 *
 * MAX_PRICE_MOVE_BY_MARGIN below is not a guess — every entry was bisected
 * against the deployed program by simulating InitMarket until it rejected.
 */

/** Accrual window, in slots, granted per crank. */
export const ACCRUAL_DT_SLOTS = 100;

/**
 * Why 100 and not 500 (the old value):
 *   - The keeper cranks every ~20s; devnet produces ~2.5 slots/s, so ~50 slots
 *     elapse per cycle. A window BELOW ~50 means the keeper can never catch up
 *     and the market drifts forever. 100 gives 2x headroom.
 *   - The budget is `price_move x window`, so a smaller window buys a
 *     proportionally larger price_move — which is what kills the freeze.
 *   - Drift recovery stays fast: 8 cranks batch into one tx (800 slots/tx), so
 *     even an 11-hour drift clears in ~2 minutes of batched cranking.
 */

/**
 * Max `max_price_move_bps_per_slot` accepted by the deployed program at
 * ACCRUAL_DT_SLOTS=100, keyed by maintenance margin (bps).
 *
 * BISECTED ON-CHAIN 2026-07-27 — do not "optimise" these upward without
 * re-running the bisection; one step too high and InitMarket rejects, which
 * fails the whole launch.
 */
const MAX_PRICE_MOVE_BY_MARGIN: ReadonlyArray<{ maintenanceBps: number; maxPriceMove: number }> = [
  { maintenanceBps: 500, maxPriceMove: 4 },   // 10x
  { maintenanceBps: 600, maxPriceMove: 5 },   // 8.33x
  { maintenanceBps: 750, maxPriceMove: 6 },   // 6.67x
  { maintenanceBps: 1000, maxPriceMove: 8 },  // 5x
  { maintenanceBps: 1250, maxPriceMove: 10 }, // 4x
  { maintenanceBps: 1500, maxPriceMove: 12 }, // 3.33x
  { maintenanceBps: 2000, maxPriceMove: 15 }, // 2.5x
];

/**
 * Leverage bounds offered to creators.
 *
 * The old `MIN_SAFE_INITIAL_MARGIN_BPS = 1500` floor (6.67x) came from a July
 * bisection that concluded "10x fails". That was a MISDIAGNOSIS, re-tested
 * 2026-07-27: 10x fails only when paired with the old 1x500 budget (500,
 * which exceeds what 500-bps maintenance allows). With a compatible budget
 * (4 x 100 = 400) **10x is accepted**. Leverage was never the problem.
 */
export const MIN_LEVERAGE_X = 2;
export const MAX_LEVERAGE_X = 10;

/** Trading fee is NOT creator-settable — one rate for every market. */
export const FIXED_TRADING_FEE_BPS = 30;

/**
 * How much collateral to seed into EACH backing domain (long + short) at
 * creation, as a percentage of the LP seed.
 *
 * This used to be a flat 0.01 test-USDC "dust" amount whose only job was to
 * defuse the backing-bucket freshness deadlock. That is fine for the LONG
 * domain — `DepositToLpVault` can top it up later. It is NOT fine for SHORT:
 * `CreateLpVault` overwrites the asset's `backing_bucket_authority` to the
 * vault registry PDA, and that field is shared by BOTH domains while a vault
 * serves only the one it was created for (domain 0). After that the creator is
 * Unauthorized (Custom 8) on TopUpBackingBucket, WithdrawBackingBucket AND
 * SyncBackingDomainLedger for both domains — verified on devnet 2026-07-27, and
 * irreversible (all three escape routes checked: UpdateAssetAuthority needs a
 * signature the PDA cannot give, CloseLpVault does not restore the field, and
 * UpdateAssetLifecycle returns AssetSlotAlreadyConfigured on an active asset).
 *
 * So whatever the SHORT domain gets at creation is all it will ever have.
 * Seeding a real amount here is the only chance to give shorts counterparty
 * backing at all.
 */
export const BACKING_SEED_PCT_OF_LP = 10n;

/** Absolute floor so a tiny LP seed still defuses the freshness deadlock. */
export const BACKING_SEED_MIN_ATOMS = 10_000n;

/** Collateral to seed into one backing domain, given the LP seed. */
export function backingSeedPerDomain(lpCollateralAtoms: bigint): bigint {
  const pct = (lpCollateralAtoms * BACKING_SEED_PCT_OF_LP) / 100n;
  return pct > BACKING_SEED_MIN_ATOMS ? pct : BACKING_SEED_MIN_ATOMS;
}

/**
 * Leverage a market actually offers, given its on-chain initial margin.
 *
 * The exact inverse of the margin derivation, which rounds UP
 * (`ceil(10000 / lev)`). That makes naive `floor(10000 / bps)` wrong for every
 * leverage that does not divide evenly: 3x stores 3334 bps, and
 * `floor(10000 / 3334)` is **2**, so a 3x market advertised itself as 2x — on
 * the review screen, the success screen, and in the markets DB's `max_leverage`
 * column. Rounding is correct because the stored bps is never more than one
 * unit above the exact value.
 */
export function leverageFromMarginBps(initialMarginBps: number): number {
  if (!Number.isFinite(initialMarginBps) || initialMarginBps <= 0) return 0;
  return Math.round(10_000 / initialMarginBps);
}

export interface DerivedMarketParams {
  initialMarginBps: number;
  maintenanceMarginBps: number;
  maxPriceMoveBpsPerSlot: number;
  maxAccrualDtSlots: number;
  /** Largest one-sided LP exposure, in base-unit q. */
  maxInventoryAbs: bigint;
  /** Largest single fill, in base-unit q. */
  maxFillAbs: bigint;
  /** Extra spread per unit of inventory; 0 disables. */
  skewSpreadMultBps: number;
  /** Worst-case seconds a max-size adverse move can block new positions. */
  estimatedFreezeSecondsFor26PctMove: number;
}

function clampLeverage(x: number): number {
  if (!Number.isFinite(x)) return MIN_LEVERAGE_X;
  return Math.min(MAX_LEVERAGE_X, Math.max(MIN_LEVERAGE_X, x));
}

/**
 * Largest price-move rate the engine will accept at this maintenance margin.
 * Interpolates DOWN (never up) between bisected points so an unlisted margin
 * can only ever be more conservative than a tested one.
 */
export function maxPriceMoveForMaintenanceBps(maintenanceBps: number): number {
  let best = MAX_PRICE_MOVE_BY_MARGIN[0].maxPriceMove;
  for (const row of MAX_PRICE_MOVE_BY_MARGIN) {
    if (maintenanceBps >= row.maintenanceBps) best = row.maxPriceMove;
    else break;
  }
  return best;
}

/**
 * Derive every risk parameter for a new market.
 *
 * @param leverageX        creator's choice, clamped to [2, 10]
 * @param lpCollateralAtoms  what the creator seeds the LP portfolio with
 * @param initialPriceE6   opening price, used to convert notional -> base q
 */
export function deriveMarketParams(
  leverageX: number,
  lpCollateralAtoms: bigint,
  initialPriceE6: bigint,
): DerivedMarketParams {
  const lev = clampLeverage(leverageX);
  // Round margin UP so the realised leverage never EXCEEDS what was asked for
  // (the engine enforces margin, so rounding down would silently grant more
  // leverage than the creator chose — and shrink the price-move budget).
  const initialMarginBps = Math.ceil(10_000 / lev);
  const maintenanceMarginBps = Math.floor(initialMarginBps / 2);
  const maxPriceMoveBpsPerSlot = maxPriceMoveForMaintenanceBps(maintenanceMarginBps);

  // ── LP guardrails ────────────────────────────────────────────────────────
  // The LP can back `lpCollateral x leverage` of notional at its own margin.
  // Cap its ONE-SIDED exposure well inside that so an adverse move can never
  // wipe it: at 40% of capacity a full adverse move to liquidation still
  // leaves the LP solvent. This is the guardrail whose absence killed Jimothy.
  const lpCapacityAtoms = lpCollateralAtoms * BigInt(Math.floor(lev));
  const inventoryCapAtoms = (lpCapacityAtoms * 40n) / 100n;
  // notional atoms -> base q:  q = notional * 1e6 / price_e6
  const px = initialPriceE6 > 0n ? initialPriceE6 : 1_000_000n;
  const maxInventoryAbs = (inventoryCapAtoms * 1_000_000n) / px;
  // A single fill may take at most a quarter of the inventory cap, so no one
  // trade can jump the LP from flat to fully loaded.
  const maxFillAbs = maxInventoryAbs / 4n;

  return {
    initialMarginBps,
    maintenanceMarginBps,
    maxPriceMoveBpsPerSlot,
    maxAccrualDtSlots: ACCRUAL_DT_SLOTS,
    maxInventoryAbs,
    maxFillAbs,
    // Widen the spread as inventory builds, so loading the LP up gets
    // progressively more expensive instead of being free at a flat 50 bps.
    skewSpreadMultBps: 50,
    estimatedFreezeSecondsFor26PctMove: Math.round((2600 / maxPriceMoveBpsPerSlot) * 0.4),
  };
}
