import { describe, it, expect } from "vitest";
import {
  deriveMarketParams,
  maxPriceMoveForMaintenanceBps,
  backingSeedPerDomain,
  ACCRUAL_DT_SLOTS,
  MIN_LEVERAGE_X,
  MAX_LEVERAGE_X,
  BACKING_SEED_MIN_ATOMS,
} from "@/lib/market-params";

/**
 * These parameters are written ONCE at market creation and can never be changed
 * — the matcher has no update instruction and max_price_move_bps_per_slot lives
 * in the engine config. A wrong value here is permanent for that market, and a
 * value one step too high makes InitMarket revert, which fails the entire
 * launch. So the constants are pinned here, not just derived.
 */

const PRICE_E6 = 1_000_000n;
const LP = 1_000_000_000n; // 1,000 units at 6dp

describe("deriveMarketParams — leverage round-trip", () => {
  it("gives the creator the leverage they picked, not a floored one", () => {
    // The regression: a 1500-bps floor (6.67x) used to override this, so a
    // creator who chose 10x silently got a 6.67x market.
    expect(deriveMarketParams(10, LP, PRICE_E6).initialMarginBps).toBe(1000);
    expect(deriveMarketParams(5, LP, PRICE_E6).initialMarginBps).toBe(2000);
    expect(deriveMarketParams(2, LP, PRICE_E6).initialMarginBps).toBe(5000);
  });

  it("rounds margin UP so realised leverage never EXCEEDS what was asked", () => {
    // 3x -> 10000/3 = 3333.33; rounding down would grant 3.0003x.
    const d = deriveMarketParams(3, LP, PRICE_E6);
    expect(d.initialMarginBps).toBe(3334);
    expect(10_000 / d.initialMarginBps).toBeLessThanOrEqual(3);
  });

  it("clamps out-of-range leverage to the offered bounds", () => {
    expect(deriveMarketParams(100, LP, PRICE_E6).initialMarginBps).toBe(
      Math.ceil(10_000 / MAX_LEVERAGE_X),
    );
    expect(deriveMarketParams(1, LP, PRICE_E6).initialMarginBps).toBe(
      Math.ceil(10_000 / MIN_LEVERAGE_X),
    );
    expect(deriveMarketParams(Number.NaN, LP, PRICE_E6).initialMarginBps).toBe(
      Math.ceil(10_000 / MIN_LEVERAGE_X),
    );
  });

  it("sets maintenance margin to half of initial", () => {
    for (const lev of [2, 3, 5, 8, 10]) {
      const d = deriveMarketParams(lev, LP, PRICE_E6);
      expect(d.maintenanceMarginBps).toBe(Math.floor(d.initialMarginBps / 2));
    }
  });
});

describe("solvency envelope — bisected on-chain 2026-07-27", () => {
  // Every pair was found by simulating InitMarket against the deployed program
  // until it rejected. One step higher on any row and the launch fails.
  const BISECTED: Array<[maintenanceBps: number, maxPriceMove: number]> = [
    [500, 4],
    [600, 5],
    [750, 6],
    [1000, 8],
    [1250, 10],
    [1500, 12],
    [2000, 15],
  ];

  it.each(BISECTED)("maintenance %i bps allows %i bps/slot", (mm, expected) => {
    expect(maxPriceMoveForMaintenanceBps(mm)).toBe(expected);
  });

  it("interpolates DOWN between bisected points, never up", () => {
    // An untested margin must inherit the LOWER neighbour's budget, so an
    // unlisted value can only ever be more conservative than a tested one.
    expect(maxPriceMoveForMaintenanceBps(999)).toBe(6); // inherits the 750 row, not the 1000 row
    expect(maxPriceMoveForMaintenanceBps(1999)).toBe(12); // inherits 1500, not 2000
    // Below the lowest bisected point there is nothing more conservative to
    // fall back to, so it holds at the first row rather than returning 0.
    expect(maxPriceMoveForMaintenanceBps(1)).toBe(4);
  });

  it("never exceeds the bisected budget for the margin it derives", () => {
    // The coherence property that actually matters: whatever leverage the
    // creator picks, the price-move rate written to the engine must be one the
    // resulting maintenance margin was proven to accept.
    for (let lev = MIN_LEVERAGE_X; lev <= MAX_LEVERAGE_X; lev += 0.25) {
      const d = deriveMarketParams(lev, LP, PRICE_E6);
      expect(d.maxPriceMoveBpsPerSlot).toBeLessThanOrEqual(
        maxPriceMoveForMaintenanceBps(d.maintenanceMarginBps),
      );
      expect(d.maxPriceMoveBpsPerSlot).toBeGreaterThan(0);
    }
  });

  it("keeps the accrual window above what the keeper can actually crank", () => {
    // The keeper cranks every ~20s and devnet makes ~2.5 slots/s, so ~50 slots
    // elapse per cycle. A window below that means the market can never catch up
    // and drifts forever.
    expect(ACCRUAL_DT_SLOTS).toBeGreaterThanOrEqual(100);
    for (const lev of [2, 5, 10]) {
      expect(deriveMarketParams(lev, LP, PRICE_E6).maxAccrualDtSlots).toBe(ACCRUAL_DT_SLOTS);
    }
  });
});

describe("LP guardrails — the caps whose absence drained Jimothy", () => {
  it("caps one-sided inventory well inside the LP's capacity", () => {
    const d = deriveMarketParams(10, LP, PRICE_E6);
    // 40% of leveraged capacity, converted notional -> base q at the open price.
    expect(d.maxInventoryAbs).toBe((LP * 10n * 40n) / 100n);
  });

  it("stops any single fill jumping the LP from flat to fully loaded", () => {
    const d = deriveMarketParams(10, LP, PRICE_E6);
    expect(d.maxFillAbs).toBe(d.maxInventoryAbs / 4n);
    expect(d.maxFillAbs).toBeGreaterThan(0n);
  });

  it("never leaves the LP an unlimited free counterparty", () => {
    // The pre-fix wizard passed i128::MAX for both caps and 0 skew, which is
    // what let a directionally-correct trader take the LP to $0.
    for (const lev of [2, 5, 10]) {
      const d = deriveMarketParams(lev, LP, PRICE_E6);
      expect(d.maxInventoryAbs).toBeGreaterThan(0n);
      expect(d.maxInventoryAbs).toBeLessThan(LP * BigInt(lev));
      expect(d.skewSpreadMultBps).toBeGreaterThan(0);
    }
  });

  it("scales the caps with price so they mean the same notional", () => {
    const cheap = deriveMarketParams(10, LP, 1_000n);
    const dear = deriveMarketParams(10, LP, 1_000_000_000n);
    expect(cheap.maxInventoryAbs).toBeGreaterThan(dear.maxInventoryAbs);
  });

  it("falls back to a sane price rather than dividing by zero", () => {
    expect(() => deriveMarketParams(10, LP, 0n)).not.toThrow();
    expect(deriveMarketParams(10, LP, 0n).maxInventoryAbs).toBeGreaterThan(0n);
  });
});

describe("backingSeedPerDomain — the SHORT domain gets one chance", () => {
  // CreateLpVault overwrites backing_bucket_authority to the vault registry
  // PDA, and that field is shared by BOTH domains while the vault serves only
  // domain 0. After that the creator is Unauthorized on every top-up path for
  // both domains — verified on devnet and irreversible. So whatever SHORT is
  // seeded with at creation is all it will ever have.
  it("seeds a real percentage of the LP, not dust", () => {
    expect(backingSeedPerDomain(LP)).toBe((LP * 10n) / 100n);
  });

  it("still clears the freshness deadlock for a tiny LP seed", () => {
    expect(backingSeedPerDomain(1n)).toBe(BACKING_SEED_MIN_ATOMS);
    expect(backingSeedPerDomain(0n)).toBe(BACKING_SEED_MIN_ATOMS);
  });

  it("is never zero — a zero seed is what deadlocks the bucket", () => {
    for (const lp of [0n, 1n, 10_000n, LP, LP * 1_000n]) {
      expect(backingSeedPerDomain(lp)).toBeGreaterThan(0n);
    }
  });
});
