// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeExactLpEarned, computeLpEarnedForVault, parseLpCostBasis, type LpCostBasis } from "@/lib/lp-earned";

/**
 * Differential test: Earn "earned" (lib/lp-earned.ts) vs the program's redemption math.
 *
 * Reference = percolator-prog @ feat/v22-rc23-2026-10-22 (d27f3d73):
 *  - non-bound: handle_execute_redemption -> execute_redemption_price_atoms
 *      src/v16_program.rs:33740  atoms = lp_atoms_for_redemption(shares, registry.total_lp_shares_outstanding, nav)
 *      (floor(shares*nav/total); same shape as lp_atoms_for_shares :8745-8756)
 *  - bound: execute_redemption_bound_pricing src/v16_program.rs:33637
 *      atoms = senior_atoms_for_redemption(shares, total, senior_value) = floor(shares*senior/S),
 *      None (tx fails) when S == 0 or shares > S   (src/vault_lp_v18.rs:140-149)
 *  - dead shares: genesis deposit mints `shares - LP_VAULT_MINIMUM_LIQUIDITY (1000)` to the depositor but
 *    registry.total_lp_shares_outstanding grows by the FULL `shares` (src/v16_program.rs:32539-32560, :32640-32650;
 *    constant :1040). So registry total = mint supply + 1000 dead shares. Redemption divides by the registry total.
 *  - price time: the redemption is priced at ExecuteRedemption (tag 77), not at RequestRedeem (tag 76 only escrows,
 *    total_lp_shares_outstanding unchanged, :32680-32690). Pending shares therefore belong at the CURRENT price.
 *
 * Indexer reference: percolator-indexer src/lpVault/position.ts foldPosition (pro-rata basis removal, floor).
 */

const DEAD = 1000n;

/** Program: floor(shares*value/total); null where the program errors. */
function programRedeem(shares: bigint, total: bigint, value: bigint): bigint | null {
  if (total === 0n || shares > total) return null;
  return (shares * value) / total;
}

/** Recover the value the app priced the claim at from the exact result. */
function appValue(r: ReturnType<typeof computeExactLpEarned>): bigint | null {
  return r.kind === "exact" ? r.unrealizedAtoms + r.costBasisAtoms : null;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const pick = (r: () => number, max: bigint): bigint => {
  // log-uniform-ish magnitude so tiny and huge values both occur
  const bits = Math.floor(r() * Number(max.toString(2).length)) + 1;
  let v = 0n;
  for (let i = 0; i < bits; i++) v = (v << 1n) | (r() < 0.5 ? 0n : 1n);
  return v > max ? max : v;
};

const mkBasis = (claim: bigint, cost = 0n, realized = 0n): LpCostBasis => ({
  basisKnown: true, lpShares: claim, costBasisAtoms: cost, realizedPnlAtoms: realized,
});

describe("lp-earned vs program redeem math (table)", () => {
  const rows: Array<{ name: string; held: bigint; pend: bigint; total: bigint; nav: bigint }> = [
    { name: "1:1", held: 1000n, pend: 0n, total: 2000n, nav: 2000n },
    { name: "floor rounding (1/3)", held: 1n, pend: 0n, total: 3n, nav: 10n },
    { name: "all shares pending", held: 0n, pend: 500n, total: 1500n, nav: 1499n },
    { name: "split held/pending", held: 7n, pend: 5n, total: 13n, nav: 1_000_003n },
    { name: "total just above dead floor", held: 1n, pend: 0n, total: DEAD + 1n, nav: 5_000n },
    { name: "sole holder owns total - dead", held: 999_000n, pend: 0n, total: 1_000_000n, nav: 1_234_567n },
    { name: "zero nav", held: 10n, pend: 0n, total: 100n, nav: 0n },
    { name: "u64-scale", held: 2n ** 63n, pend: 2n ** 62n, total: 2n ** 64n - 1n, nav: 2n ** 70n + 12345n },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const claim = r.held + r.pend;
      const app = computeExactLpEarned({
        basis: mkBasis(claim, 1n), userLpBalance: r.held, pendingRedemptionShares: r.pend,
        vaultTotalAtoms: r.nav, lpSupply: r.total,
      });
      expect(appValue(app)).toBe(programRedeem(claim, r.total, r.nav));
      // pending shares are priced as held shares at the same NAV (one ExecuteRedemption pays the sum, floored once)
      const split = programRedeem(r.held, r.total, r.nav)! + programRedeem(r.pend, r.total, r.nav)!;
      expect(appValue(app)! - split).toBeGreaterThanOrEqual(0n); // floor-once never below floor-twice
      expect(appValue(app)! - split).toBeLessThanOrEqual(1n);
    });
  }

  it("DEAD SHARES: pricing over the LP mint supply (registry total - 1000) overstates the payout; callers must pass the registry total", () => {
    const registryTotal = 1_000_000n;
    const mintSupply = registryTotal - DEAD;
    const held = mintSupply; // sole holder
    const nav = 1_000_000n;
    const viaRegistry = appValue(computeExactLpEarned({
      basis: mkBasis(held, 0n), userLpBalance: held, pendingRedemptionShares: 0n, vaultTotalAtoms: nav, lpSupply: registryTotal,
    }));
    const viaMint = appValue(computeExactLpEarned({
      basis: mkBasis(held, 0n), userLpBalance: held, pendingRedemptionShares: 0n, vaultTotalAtoms: nav, lpSupply: mintSupply,
    }));
    expect(viaRegistry).toBe(programRedeem(held, registryTotal, nav)); // 999_000
    expect(viaMint).toBe(nav); // would show 1_000 atoms of phantom earnings the program never pays
    expect(viaMint! - viaRegistry!).toBe(DEAD * nav / registryTotal);
  });

  it("claim > registry total: program errors (null) while the app still prints a figure (out-of-sync inputs only)", () => {
    const app = computeExactLpEarned({
      basis: mkBasis(11n, 0n), userLpBalance: 11n, pendingRedemptionShares: 0n, vaultTotalAtoms: 100n, lpSupply: 10n,
    });
    expect(programRedeem(11n, 10n, 100n)).toBeNull();
    expect(app.kind).toBe("exact"); // documented gap: unreachable when lpSupply is the registry total and claim is on-chain-backed
  });
});

describe("lp-earned vs program redeem math (10k seeded cases)", () => {
  it("non-bound path: value == floor(claim*nav/registryTotal) for every case; 0 mismatches", () => {
    const r = rng(0xc0ffee);
    let mismatches = 0, n = 0;
    for (let i = 0; i < 12_000; i++) {
      const total = DEAD + 1n + pick(r, 2n ** 64n);
      const claim = pick(r, total - DEAD); // holders can never own the dead shares
      const pend = r() < 0.5 ? 0n : pick(r, claim);
      const held = claim - pend;
      const nav = pick(r, 2n ** 72n);
      const cost = pick(r, 2n ** 70n);
      const realized = r() < 0.5 ? 0n : pick(r, 2n ** 60n) - 2n ** 59n;
      const res = computeLpEarnedForVault(
        mkBasis(claim, cost, realized),
        { userLpBalance: held, pendingRedemptionShares: pend, vaultTotalAtoms: nav, lpSupply: total - DEAD, splitPot: { totalShares: total } },
      );
      const expected = programRedeem(claim, total, nav);
      n++;
      if (res.kind !== "exact" || appValue(res) !== expected || res.earnedAtoms !== expected! - cost + realized) mismatches++;
    }
    expect(n).toBeGreaterThanOrEqual(10_000);
    expect(mismatches).toBe(0);
  });

  it("bound path: priced on withdrawSeniorValue / registry shares; 0 mismatches", () => {
    const r = rng(0xbeef);
    let mismatches = 0;
    for (let i = 0; i < 10_000; i++) {
      const total = DEAD + 1n + pick(r, 2n ** 64n);
      const claim = pick(r, total - DEAD);
      const pend = r() < 0.5 ? 0n : pick(r, claim);
      const senior = pick(r, 2n ** 72n);
      const res = computeLpEarnedForVault(
        mkBasis(claim, 5n, 0n),
        { bound: true, userLpBalance: claim - pend, pendingRedemptionShares: pend, vaultTotalAtoms: 123n, lpSupply: total - DEAD, splitPot: null },
        { totalShares: total, withdrawSeniorValue: senior },
      );
      if (res.kind !== "exact" || appValue(res) !== programRedeem(claim, total, senior)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("price-time: pending shares are valued at the CURRENT nav, like ExecuteRedemption (not the queue-time nav)", () => {
    const r = rng(42);
    for (let i = 0; i < 2_000; i++) {
      const total = DEAD + 1n + pick(r, 2n ** 50n);
      const pend = 1n + pick(r, total - DEAD - 1n);
      const navQueue = pick(r, 2n ** 60n), navNow = pick(r, 2n ** 60n);
      const res = computeExactLpEarned({
        basis: mkBasis(pend, 0n), userLpBalance: 0n, pendingRedemptionShares: pend, vaultTotalAtoms: navNow, lpSupply: total,
      });
      expect(appValue(res)).toBe(programRedeem(pend, total, navNow));
      void navQueue; // tag 76 records no price; nothing at queue time influences tag 77
    }
  });

  it("near the dead-share floor: total in [1001, 1100] never divides by zero and matches the program", () => {
    for (let total = DEAD + 1n; total <= DEAD + 100n; total++) {
      for (const claim of [1n, (total - DEAD) / 2n || 1n, total - DEAD]) {
        for (const nav of [0n, 1n, total, 10n ** 9n + 7n]) {
          const res = computeExactLpEarned({ basis: mkBasis(claim, 0n), userLpBalance: claim, pendingRedemptionShares: 0n, vaultTotalAtoms: nav, lpSupply: total });
          expect(appValue(res)).toBe(programRedeem(claim, total, nav));
        }
      }
    }
  });
});

/** Port of indexer foldPosition's money fields (position.ts) for the basis-field cross-check. */
function fold(events: Array<{ k: "dep" | "req" | "can" | "exe"; coll: bigint; lp: bigint }>) {
  let shares = 0n, pending = 0n, basis = 0n, realized = 0n, dep = 0n, red = 0n;
  for (const e of events) {
    if (e.k === "dep") { dep += e.coll; shares += e.lp; basis += e.coll; }
    else if (e.k === "req") pending += e.lp;
    else if (e.k === "can") pending = pending > e.lp ? pending - e.lp : 0n;
    else {
      red += e.coll;
      const removed = e.lp === shares ? basis : (basis * e.lp) / shares;
      realized += e.coll - removed; basis -= removed; shares -= e.lp;
      pending = pending > e.lp ? pending - e.lp : 0n;
    }
  }
  return { shares, pending, basis, realized, dep, red };
}

describe("parseLpCostBasis / earned vs indexer basis fields", () => {
  it("the API payload built from an indexer fold round-trips and earned == value + redeemed - deposited (seeded)", () => {
    const r = rng(7);
    let checked = 0;
    for (let i = 0; i < 3_000; i++) {
      const ev: Parameters<typeof fold>[0] = [];
      let sh = 0n;
      const steps = 1 + Math.floor(r() * 6);
      for (let s = 0; s < steps; s++) {
        if (sh === 0n || r() < 0.5) {
          const lp = 1n + pick(r, 10n ** 12n);
          ev.push({ k: "dep", coll: 1n + pick(r, 10n ** 13n), lp }); sh += lp;
        } else {
          const lp = 1n + (pick(r, sh - 1n + 1n) % sh);
          ev.push({ k: "exe", coll: pick(r, 10n ** 13n), lp }); sh -= lp;
        }
      }
      const f = fold(ev);
      const payload = {
        available: true, basisKnown: true, lpShares: f.shares.toString(), pendingRedeemShares: f.pending.toString(),
        costBasisAtoms: f.basis.toString(), realizedPnlAtoms: f.realized.toString(),
      };
      const parsed = parseLpCostBasis(payload);
      expect(parsed).toEqual({ basisKnown: true, lpShares: f.shares, costBasisAtoms: f.basis, realizedPnlAtoms: f.realized });
      if (f.shares === 0n) { expect(f.basis).toBe(0n); }
      if (f.shares === 0n) continue;
      const total = DEAD + f.shares + pick(r, 10n ** 12n);
      const nav = pick(r, 10n ** 14n);
      const res = computeExactLpEarned({ basis: parsed, userLpBalance: f.shares, pendingRedemptionShares: 0n, vaultTotalAtoms: nav, lpSupply: total });
      const value = programRedeem(f.shares, total, nav)!;
      // cash-flow identity: earned = value now + cash out - cash in (basis fold conserves atoms exactly)
      expect(res.kind === "exact" && res.earnedAtoms).toBe(value + f.red - f.dep);
      checked++;
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("parseLpCostBasis: strictness (non-string / non-integer / missing -> null; basisKnown only when === true; negative realized ok)", () => {
    const ok = { available: true, basisKnown: true, lpShares: "5", costBasisAtoms: "7", realizedPnlAtoms: "-3" };
    expect(parseLpCostBasis(ok)).toEqual({ basisKnown: true, lpShares: 5n, costBasisAtoms: 7n, realizedPnlAtoms: -3n });
    expect(parseLpCostBasis({ ...ok, basisKnown: "true" })?.basisKnown).toBe(false);
    for (const bad of [null, 1, "x", { available: false }, { ...ok, lpShares: 5 }, { ...ok, costBasisAtoms: "1.5" }, { ...ok, realizedPnlAtoms: undefined }, { ...ok, lpShares: "" }]) {
      expect(parseLpCostBasis(bad)).toBeNull();
    }
  });
});
