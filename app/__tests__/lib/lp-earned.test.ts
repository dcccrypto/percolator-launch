// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeExactLpEarned, computeLpEarnedForVault, parseLpCostBasis, type LpCostBasis } from "@/lib/lp-earned";

/** percolator-indexer#207: exact Earn "earned" from the indexed cost basis. */
const basis = (o: Partial<LpCostBasis> = {}): LpCostBasis => ({
  basisKnown: true, lpShares: 1000n, costBasisAtoms: 1100n, realizedPnlAtoms: 0n, ...o,
});

describe("computeExactLpEarned", () => {
  it("late depositor at NAV 1.1 has earned 0 — the #2675 counter-example the par estimate got wrong (+100)", () => {
    const r = computeExactLpEarned({
      basis: basis(), userLpBalance: 1000n, pendingRedemptionShares: 0n, vaultTotalAtoms: 2200n, lpSupply: 2000n,
    });
    expect(r).toEqual({ kind: "exact", earnedAtoms: 0n, unrealizedAtoms: 0n, realizedAtoms: 0n, costBasisAtoms: 1100n });
  });

  it("appreciation after entry is earned; realized from past redemptions is added", () => {
    const r = computeExactLpEarned({
      basis: basis({ realizedPnlAtoms: 25n }), userLpBalance: 1000n, pendingRedemptionShares: 0n,
      vaultTotalAtoms: 2400n, lpSupply: 2000n, // NAV 1.2
    });
    expect(r.kind === "exact" && r.unrealizedAtoms).toBe(100n);
    expect(r.kind === "exact" && r.earnedAtoms).toBe(125n);
  });

  it("a NAV drop shows a negative figure, not zero", () => {
    const r = computeExactLpEarned({
      basis: basis(), userLpBalance: 1000n, pendingRedemptionShares: 0n, vaultTotalAtoms: 2000n, lpSupply: 2000n,
    });
    expect(r.kind === "exact" && r.earnedAtoms).toBe(-100n);
  });

  it("shares escrowed in a pending redemption still count toward the claim", () => {
    const r = computeExactLpEarned({
      basis: basis(), userLpBalance: 600n, pendingRedemptionShares: 400n, vaultTotalAtoms: 2200n, lpSupply: 2000n,
    });
    expect(r.kind).toBe("exact");
  });

  it("is unavailable when the indexer says the basis is unknown (LP transferred)", () => {
    expect(computeExactLpEarned({
      basis: basis({ basisKnown: false }), userLpBalance: 1000n, pendingRedemptionShares: 0n, vaultTotalAtoms: 2200n, lpSupply: 2000n,
    })).toEqual({ kind: "unavailable", reason: "basis-unknown" });
  });

  it("is unavailable when indexed shares differ from the on-chain claim (indexer behind)", () => {
    expect(computeExactLpEarned({
      basis: basis(), userLpBalance: 1500n, pendingRedemptionShares: 0n, vaultTotalAtoms: 2200n, lpSupply: 2000n,
    })).toEqual({ kind: "unavailable", reason: "out-of-sync" });
  });

  it("is unavailable with no data", () => {
    expect(computeExactLpEarned({
      basis: null, userLpBalance: 1n, pendingRedemptionShares: 0n, vaultTotalAtoms: 1n, lpSupply: 1n,
    })).toEqual({ kind: "unavailable", reason: "no-data" });
  });
});

describe("parseLpCostBasis", () => {
  it("parses decimal strings into bigints without float loss", () => {
    expect(parseLpCostBasis({
      available: true, basisKnown: true, lpShares: "340282366920938463463374607431768211455",
      costBasisAtoms: "5000000000", realizedPnlAtoms: "-12",
    })).toEqual({
      basisKnown: true, lpShares: 340282366920938463463374607431768211455n, costBasisAtoms: 5_000_000_000n, realizedPnlAtoms: -12n,
    });
  });
  it("rejects unavailable / malformed payloads", () => {
    expect(parseLpCostBasis({ available: false })).toBeNull();
    expect(parseLpCostBasis({ available: true, lpShares: 1, costBasisAtoms: "1", realizedPnlAtoms: "0" })).toBeNull();
    expect(parseLpCostBasis(null)).toBeNull();
  });
  it("treats a missing basisKnown as unknown", () => {
    expect(parseLpCostBasis({ available: true, lpShares: "1", costBasisAtoms: "1", realizedPnlAtoms: "0" })?.basisKnown).toBe(false);
  });
});

describe("computeLpEarnedForVault (rebased onto the two-pot NAV, #2812/#2814)", () => {
  // Two-pot vault: NAV 3300 over 3000 registry shares (1.1/share) while the LP mint
  // supply reads 2000. The card's Value prices 1000 shares at 1100, so Earned must be 0.
  const twoPot = {
    userLpBalance: 1000n, pendingRedemptionShares: 0n,
    vaultTotalAtoms: 3300n, lpSupply: 2000n, splitPot: { totalShares: 3000n },
  };

  it("prices the claim over the registry's shares on a two-pot vault, matching Value", () => {
    const r = computeLpEarnedForVault(basis(), twoPot);
    expect(r).toEqual({ kind: "exact", earnedAtoms: 0n, unrealizedAtoms: 0n, realizedAtoms: 0n, costBasisAtoms: 1100n });
  });

  it("falls back to the LP mint supply on a bound vault (no split pot)", () => {
    const r = computeLpEarnedForVault(basis(), { ...twoPot, vaultTotalAtoms: 2400n, splitPot: null });
    expect(r.kind === "exact" && r.earnedAtoms).toBe(100n);
  });
});
