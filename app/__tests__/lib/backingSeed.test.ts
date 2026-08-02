/**
 * Counterparty-backing seed — the gain-support budget that decides whether an
 * LP can ever recover from a drawdown.
 *
 * THE BUG THIS PINS (verified on the ZERO market, 5PRM2X5H…, 2026-08-02)
 * ---------------------------------------------------------------------
 * The engine credits an LP's GAINS from the domain OPPOSITE its leg, capped by
 * that domain's available backing (v16.rs:7184 -> :1141). Its LOSSES apply in
 * full and confiscate capital into the SAME-side domain (v16.rs:9046). When the
 * opposite domain's budget hits zero, `support_consumed` is 0 and every gain is
 * silently DISCARDED while losses keep landing — a one-way ratchet to
 * bankruptcy regardless of where the price ends up.
 *
 * ZERO was seeded at the old 10% (LP $1,000 -> $100/domain). Measured on chain:
 *   source_credit_LONG.spent_backing_num      = $99.999999  (the ENTIRE seed)
 *   source_credit_LONG.fresh_reserved_backing = $ 0.000001
 *   LP capital $1,000 -> $0, crystallized $1,000, pnl -$775 and falling,
 *   while the price sat within 294 units of the LP's entry (~$129 of real risk).
 *
 * So the invariant is: the gain-support budget must be at least the LP's loss
 * capacity — its collateral — or the LP is guaranteed to strand after earning
 * back only a fraction of a drawdown.
 */
import { describe, it, expect } from "vitest";
import {
  BACKING_SEED_PCT_OF_LP,
  BACKING_SEED_MIN_ATOMS,
  backingSeedPerDomain,
} from "@/lib/market-params";

/** The real ZERO configuration. */
const LP_1000 = 1_000_000_000n; // $1,000 in 6dp atoms

describe("backingSeedPerDomain — gain-support budget", () => {
  it("seeds each domain with at least the LP's full collateral", () => {
    // The core invariant. At the old 10% this was $100 against $1,000 of loss
    // capacity, which is what killed ZERO.
    expect(backingSeedPerDomain(LP_1000)).toBeGreaterThanOrEqual(LP_1000);
  });

  it("is NOT the old 10% that stranded ZERO", () => {
    const old10pct = (LP_1000 * 10n) / 100n; // $100
    expect(backingSeedPerDomain(LP_1000)).toBeGreaterThan(old10pct);
    expect(BACKING_SEED_PCT_OF_LP).toBeGreaterThanOrEqual(100n);
  });

  it("covers the exact drawdown ZERO could not recover from", () => {
    // ZERO's LP needed to earn back ~$1,650 of discarded gains; it had $100.
    // With collateral-parity seeding it can recover any drawdown up to the
    // point of bankruptcy ($1,000), which is the most it can survive anyway.
    const seed = backingSeedPerDomain(LP_1000);
    const maxSurvivableDrawdown = LP_1000; // beyond this the LP is bankrupt
    expect(seed).toBeGreaterThanOrEqual(maxSurvivableDrawdown);
  });

  it("scales with the LP seed", () => {
    expect(backingSeedPerDomain(2_000_000_000n)).toBe(
      backingSeedPerDomain(1_000_000_000n) * 2n,
    );
  });

  it("still honours the absolute floor for a dust LP", () => {
    // The floor exists to defuse the backing-bucket freshness deadlock even
    // when the percentage would round to ~nothing.
    expect(backingSeedPerDomain(1n)).toBe(BACKING_SEED_MIN_ATOMS);
    expect(backingSeedPerDomain(0n)).toBe(BACKING_SEED_MIN_ATOMS);
  });

  it("never returns zero — a zero budget is the ratchet condition itself", () => {
    for (const lp of [0n, 1n, 1_000n, LP_1000, 10_000_000_000n]) {
      expect(backingSeedPerDomain(lp)).toBeGreaterThan(0n);
    }
  });
});
