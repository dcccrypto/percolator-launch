// @vitest-environment node
/**
 * Earn cards: claim-adjusted NAV, "max withdrawable now", and the non-withdrawable flags (audit 2026-10-04
 * lp-earn.md §2, §8). The shapes below are the live vaults: OTC / Jimothy / STONK (0% redeemable now, Custom 21
 * at the stay-fully-backed gate), backpack / USELESS (NAV 0, Custom 34), SI (partial), a healthy vault.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import type { DomainState, SplitPotState } from "@/lib/limits/earn-split-pot";
import { atomsToUsd, vaultWithdrawView, withdrawChip, withdrawFlagLine } from "@/lib/limits/earn-withdrawable";

const BS = C.BOUND_SCALE;
const ledger = (principal: bigint, loss = 0n, recovery = 0n) => ({
  totalPrincipal: principal, totalEarnings: 0n, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n,
  cumulativeLoss: loss, cumulativeRecovery: recovery, lastObsUnavailable: 0n,
});
const source = (freshReservedAtoms: bigint, claimsAtoms = 0n) => ({
  positiveClaimBound: claimsAtoms * BS, freshReserved: freshReservedAtoms * BS, validLienedBacking: 0n,
  insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n,
});
const bucket = (freshAtoms: bigint, consumedAtoms = 0n) => ({
  freshUnliened: freshAtoms * BS, validLiened: 0n, consumed: consumedAtoms * BS, impaired: 0n, utilFeeEarnings: 0n, status: 1,
});
const pot = (freshAtoms: bigint, principal: bigint, claims = 0n, loss = 0n): DomainState => ({
  bucket: bucket(freshAtoms), source: source(freshAtoms, claims), ledger: ledger(principal, loss),
});
const empty: DomainState = { bucket: { ...bucket(0n), status: 0 }, source: source(0n), ledger: null };
const vault = (own: DomainState, sib: DomainState, totalShares: bigint, navFloor = true): SplitPotState => ({
  own, sib, ownDomain: 0, totalShares, feeShareBps: 1000,
  ownLedger: Keypair.generate().publicKey, sibLedger: Keypair.generate().publicKey, navFloor,
});

describe("vaultWithdrawView", () => {
  it("a healthy vault: nothing owed to winners, everything can leave, no flag", () => {
    const w = vaultWithdrawView(vault(pot(2_000_000_000n, 2_000_000_000n), empty, 2_000_000_000n))!;
    expect(w.status).toBe("open");
    expect(w.nav).toBe(2_000_000_000n);
    expect(w.claimAdjustedNav).toBe(2_000_000_000n);
    expect(w.maxWithdrawableNow).toBe(2_000_000_000n);
    expect(w.payableBps).toBe(10_000);
    expect(withdrawChip(w.status)).toBeNull();
    expect(withdrawFlagLine(w.status)).toBeNull();
  });

  it("claim-adjusted NAV: Agency shape, winner claims reserve part of the backing (12,129.92 -> 11,938.88)", () => {
    // fresh 15,130.92 backing, 3,192.04 of positive claims -> 11,938.88 free; ledger principal 12,129.92.
    const own = pot(15_130_920_000n, 12_129_920_000n, 3_192_040_000n);
    const w = vaultWithdrawView(vault(own, empty, 12_129_920_000n))!;
    expect(w.nav).toBe(12_129_920_000n);
    expect(w.claimAdjustedNav).toBe(11_938_880_000n);
    expect(atomsToUsd(w.claimAdjustedNav, 6)).toBeCloseTo(11_938.88, 2);
    // Only what is free of claims can leave: just under the claim-adjusted figure.
    expect(w.maxWithdrawableNow).toBeLessThanOrEqual(w.claimAdjustedNav);
    expect(w.maxWithdrawableNow).toBeGreaterThan(0n);
    // 98.3% of the vault can leave: close enough to "open" that a chip would be noise (live Agency pays 98.3%).
    expect(w.payableBps).toBeGreaterThan(9_500);
    expect(w.status).toBe("open");
  });

  it("OTC / Jimothy / STONK shape: the vault's money backs open winners, 0% redeemable now -> blocked", () => {
    // Principal 1,000 is worth 1,000 but every atom of fresh backing is reserved by claims.
    const w = vaultWithdrawView(vault(pot(1_000_000_000n, 1_000_000_000n, 1_000_000_000n), empty, 1_000_000_000n))!;
    expect(w.nav).toBe(1_000_000_000n);
    expect(w.maxWithdrawableNow).toBe(0n);
    expect(w.claimAdjustedNav).toBe(0n);
    expect(w.status).toBe("blocked");
    expect(withdrawChip(w.status)).toBe("Can't withdraw now");
    expect(withdrawFlagLine(w.status)).toMatch(/unavailable now/);
  });

  it("backpack / USELESS shape: loss equals principal, NAV 0 -> worthless (a 77 prices to 0, Custom 34)", () => {
    const dead = pot(1_000_000_000n, 2_000_000_000n, 0n, 2_000_000_000n);
    const w = vaultWithdrawView(vault(dead, pot(0n, 0n), 2_000_000_000n))!;
    expect(w.nav).toBe(0n);
    expect(w.status).toBe("worthless");
    expect(withdrawChip(w.status)).toBe("Worth ~0");
  });

  it("price collapse (nav * 1000 < shares) is worthless even when nav is not exactly 0", () => {
    // OTC 0.0067/share is still sellable; 0.0009/share is below the program's collapse floor.
    const w = vaultWithdrawView(vault(pot(1_000_000n, 1_000_000n), empty, 2_000_000_000n))!;
    expect(w.nav).toBe(1_000_000n);
    expect(w.status).toBe("worthless");
  });

  it("half the backing reserved for winners (swordcat / MICRO shape): part can leave now -> limited, with a number", () => {
    const w = vaultWithdrawView(vault(pot(2_000_000_000n, 2_000_000_000n, 1_000_000_000n), empty, 2_000_000_000n))!;
    expect(w.status).toBe("limited");
    expect(w.payableBps).toBeLessThan(9_500);
    expect(w.maxWithdrawableNow).toBeGreaterThan(0n);
    expect(w.maxWithdrawableNow).toBeLessThan(w.nav);
    expect(withdrawChip(w.status)).toBe("Partly withdrawable");
  });

  it("SI fork fixture (2026-10-01): the full exit is refused by the program, yet 99.998% can leave -> open, not noisy", () => {
    const SI_OWN: DomainState = { bucket: bucket(1_603_372_739n), source: source(1_603_372_739n, 596_957n), ledger: ledger(1_602_825_164n) };
    const SI_SIB: DomainState = { bucket: bucket(1_000_000_002n, 32_976n), source: source(1_000_000_002n), ledger: ledger(1_000_000_000n) };
    const w = vaultWithdrawView(vault(SI_OWN, SI_SIB, 2_599_992_799n, false))!;
    expect(w.status).toBe("open");
    expect(w.maxWithdrawableNow).toBeLessThan(w.nav); // still reports the real cap
  });

  it("NEGATIVE CONTROL: a vault is flagged by what the pots say, not by who it is (same numbers, same verdict)", () => {
    const a = vaultWithdrawView(vault(pot(1_000_000_000n, 1_000_000_000n, 1_000_000_000n), empty, 1_000_000_000n))!;
    const b = vaultWithdrawView(vault(pot(1_000_000_000n, 1_000_000_000n, 0n), empty, 1_000_000_000n))!;
    expect(a.status).toBe("blocked");
    expect(b.status).toBe("open");
  });

  it("no shares -> no view (never a divide by zero)", () => {
    expect(vaultWithdrawView(vault(pot(1n, 1n), empty, 0n))).toBeNull();
  });

  it("copy is calm, one line, no time promise", () => {
    for (const s of ["worthless", "blocked", "limited"] as const) {
      const line = withdrawFlagLine(s)!;
      expect(line.length).toBeLessThan(110);
      expect(line).not.toMatch(/seconds|minutes|soon/i);
    }
  });
});
