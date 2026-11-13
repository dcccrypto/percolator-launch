// @vitest-environment node
/**
 * M-9 (code review 2026-10-01): a BOUND (P3) vault's backing NAV is the wrapper's
 * `vault_lp_v18::bound_vault_nav` (deployed 553d76f0, via `lp_vault_combined_nav_parts_p3`):
 *   per pot  min(total_principal, (fresh_unliened + valid_liened) / BOUND_SCALE)
 *   plus     floor((total_earnings - withdrawn) * fee_share / 10_000)  of each SYNCED ledger.
 * Not shares + feeDistributionTotal, and not the ledger-impairment NAV a two-pot vault uses.
 */
import { describe, expect, it } from "vitest";
import * as C from "@/lib/limits/constants";
import { boundVaultNav, combinedVault, vaultBackingNav, type DomainState } from "@/lib/limits/earn-split-pot";

const BS = C.BOUND_SCALE;
const src = { positiveClaimBound: 0n, freshReserved: 0n, validLienedBacking: 0n, insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n };
const pot = (p: { principal: bigint; fresh: bigint; liened?: bigint; consumed?: bigint; earnings?: bigint; withdrawn?: bigint; bucketFees?: bigint }): DomainState => ({
  bucket: { freshUnliened: p.fresh * BS, validLiened: (p.liened ?? 0n) * BS, consumed: (p.consumed ?? 0n) * BS, impaired: 0n, utilFeeEarnings: p.bucketFees ?? 0n, status: 1 },
  source: src,
  ledger: {
    totalPrincipal: p.principal, totalEarnings: p.earnings ?? 0n, totalEarningsWithdrawn: p.withdrawn ?? 0n,
    lastObsBucketEarnings: 0n, cumulativeLoss: 0n, cumulativeRecovery: 0n, lastObsUnavailable: 0n,
  },
});

describe("boundVaultNav (wrapper bound_vault_nav)", () => {
  it("owns min(principal, held) per pot and adds each pot's synced LP earnings", () => {
    // own: principal 1,000, held 800 fresh + 100 liened = 900 (100 lent to a winner = real loss);
    //      ledger earnings 100 + 50 unsynced bucket fees - 10 withdrawn = 140 -> 10% = 14.
    // sib: principal 500, held 700 (200 above principal = the LP's settled loss, not the seniors').
    const own = pot({ principal: 1_000n, fresh: 800n, liened: 100n, earnings: 100n, withdrawn: 10n, bucketFees: 50n });
    const sib = pot({ principal: 500n, fresh: 700n });
    expect(boundVaultNav(own, sib, 1_000)).toEqual({ available: 1_400n, nav: 1_414n });
    expect(vaultBackingNav({ own, sib, bound: true, feeShareBps: 1_000, ownDomain: 0, totalShares: 1_500n, ownLedger: null as never, sibLedger: null as never })).toBe(1_414n);
  });

  it("ignores the ledgers' impairment counters (B24): consumed backing above principal is not a senior loss", () => {
    // Backing consumed out of the above-principal reserve books impairment on the ledger; the
    // two-pot NAV would subtract it, the bound NAV does not (the pot still holds its principal).
    const own = pot({ principal: 1_000n, fresh: 1_000n, consumed: 300n });
    const sib = pot({ principal: 0n, fresh: 0n });
    expect(boundVaultNav(own, sib, 0)!.nav).toBe(1_000n);
    expect(combinedVault(own, sib, 0)!.nav).toBe(700n);
  });

  it("floors held per pot and never goes negative on over-withdrawn earnings", () => {
    const own: DomainState = { ...pot({ principal: 10n, fresh: 0n, earnings: 5n, withdrawn: 9n }), bucket: { ...pot({ principal: 0n, fresh: 0n }).bucket, freshUnliened: 7n * BS + (BS - 1n) } };
    const sib = pot({ principal: 0n, fresh: 0n });
    expect(boundVaultNav(own, sib, 10_000)).toEqual({ available: 7n, nav: 7n });
  });

  it("an unseeded ledger contributes 0 principal (the program seeds it zeroed)", () => {
    const sib: DomainState = { ...pot({ principal: 0n, fresh: 400n }), ledger: null };
    expect(boundVaultNav(pot({ principal: 100n, fresh: 100n }), sib, 1_000)!.nav).toBe(100n);
  });

  it("refuses a fee share above 100% like the program (EngineInvalidConfig)", () => {
    expect(boundVaultNav(pot({ principal: 1n, fresh: 1n }), pot({ principal: 0n, fresh: 0n }), 10_001)).toBeNull();
  });
});
