/**
 * Non-bound Earn around the wrapper 7a3ac04c+ upgrade (NAV floor fdf07759 + security review
 * 2026-10-03 H-1 / B-2):
 *   - deposits (75): never sent while a pot is over-impaired or the share price has collapsed
 *     (`planEarnDeposit`), otherwise routed to the pot whose principal covers its impairment;
 *   - the reverse-91 repair prefix: kept on the LIVE wrapper (it is what lets 75/77 price at all
 *     today, Custom 25), never sent once the upgrade is detected (`navFloor`, B-2);
 *   - the maths (availablePrincipal / domainNav / combinedVault / planSplitPotRedemption) apply
 *     the per-pot floor only when `navFloor` (today's program still fails closed with 25).
 *
 * Fixtures: the live SI 8WC8vALs ledgers (2026-10-02, d1 lost 1,107.721 vs 1,000 principal), as in
 * earn-split-pot.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import {
  EARN_PRICE_COLLAPSE_FACTOR,
  EARN_MAX_DEPOSIT_IMPAIRMENT_BPS,
  potImpairmentParts,
  vaultImpairmentExceeds,
  availablePrincipal,
  combinedVault,
  domainNav,
  planEarnDeposit,
  planSplitPotRedemption,
  splitPotPrefixIxs,
  vaultValue,
  movablePrincipal,
  potDeficit,
  repairUnderwaterPot,
  syncedLedger,
  type DomainState,
  type SplitPotState,
} from "@/lib/limits/earn-split-pot";

const BS = C.BOUND_SCALE;
const ledger = (principal: bigint, loss = 0n, recovery = 0n, unavailable = 0n) => ({
  totalPrincipal: principal, totalEarnings: 0n, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n,
  cumulativeLoss: loss, cumulativeRecovery: recovery, lastObsUnavailable: unavailable,
});
const source = (freshReservedAtoms: bigint, pcbAtoms = 0n) => ({
  positiveClaimBound: pcbAtoms * BS, freshReserved: freshReservedAtoms * BS, validLienedBacking: 0n,
  insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n,
});
const bucket = (freshAtoms: bigint, consumedAtoms = 0n) => ({
  freshUnliened: freshAtoms * BS, validLiened: 0n, consumed: consumedAtoms * BS, impaired: 0n, utilFeeEarnings: 0n, status: 1,
});
const L0 = Keypair.generate().publicKey;
const L1 = Keypair.generate().publicKey;
const vault = (own: DomainState, sib: DomainState, ownDomain = 0, navFloor = false, totalShares = 2_699_885_245n): SplitPotState => ({
  own, sib, ownDomain, totalShares, feeShareBps: 1000, ownLedger: L0, sibLedger: L1, navFloor,
});
const prefix = (sp: SplitPotState, payoutShares?: bigint) =>
  splitPotPrefixIxs({ programId: L0, cranker: L1, market: L0, registry: L1, sp, payoutShares });

const HEALTHY: DomainState = {
  bucket: bucket(1_083_616_340n, 851_301_283n),
  source: source(1_083_616_340n, 844_377_403n),
  ledger: ledger(1_703_549_886n, 1_009_226_428n, 157_705_543n, 851_301_283n),
};
const UNDERWATER: DomainState = {
  bucket: { ...bucket(0n, 1_107_721_000n), freshUnliened: 1_000_000_000_000n },
  source: { ...source(0n, 0n), positiveClaimBound: 2_745_796n * BS, freshReserved: 1_000_000_000_000n },
  ledger: ledger(1_000_000_000n, 1_107_721_000n, 0n, 1_107_721_000n),
};
// HEALTHY with almost no credit room: it cannot fund the 107.721 repair, so nothing in front of the
// deposit can lift the underwater pot (the 10-02 OTC shape).
const HEALTHY_THIN: DomainState = { ...HEALTHY, source: { ...HEALTHY.source, positiveClaimBound: HEALTHY.source.freshReserved - 100n * BS } };
/** An unimpaired pot (principal 1,000 tokens, fully backed). */
const CLEAN: DomainState = { bucket: bucket(1_000_000_000n), source: source(1_000_000_000n), ledger: ledger(1_000_000_000n) };

describe("planEarnDeposit: LIVE wrapper (navFloor false) — the repair prefix still runs first", () => {
  it("both pots healthy: own pot, no prefix", () => {
    const sp = vault(CLEAN, CLEAN);
    expect(planEarnDeposit(sp)).toEqual({ ok: true, domain: 0 });
    expect(prefix(sp)).toEqual([]);
  });

  it("sibling underwater but repairable (SI today): the repair would lift the pot, but the vault is >10% impaired -> paused", () => {
    const sp = vault(HEALTHY, UNDERWATER);
    expect(prefix(sp)).toHaveLength(1);
    // R-1 mirrored pre-upgrade too: SI's d0 alone is ~50% impaired.
    expect(planEarnDeposit(sp)).toEqual({ ok: false, reason: "vault-impaired" });
  });

  it("an underwater pot whose repair leaves the vault <=10% impaired: repair 91 rides first, own pot", () => {
    // d1 lost 1,000.5 vs 1,000 principal; d0 is a clean 20,000-token pot that can fund the repair.
    const BIG: DomainState = { bucket: bucket(20_000_000_000n), source: source(20_000_000_000n), ledger: ledger(20_000_000_000n) };
    const SMALL_UNDER: DomainState = { bucket: bucket(0n, 1_000_500_000n), source: source(0n), ledger: ledger(1_000_000_000n, 1_000_500_000n, 0n, 1_000_500_000n) };
    const sp = vault(BIG, SMALL_UNDER);
    expect(prefix(sp)).toHaveLength(1);
    expect(planEarnDeposit(sp)).toEqual({ ok: true, domain: 0 });
  });

  it("underwater and NOT repairable (OTC 10-02 shape): not sent (the program would refuse 25)", () => {
    const sp = vault(UNDERWATER, HEALTHY_THIN);
    expect(movablePrincipal(HEALTHY_THIN)).toBeLessThan(107_721_000n);
    expect(repairUnderwaterPot(sp)).toBeNull();
    expect(planEarnDeposit(sp)).toEqual({ ok: false, reason: "pot-impaired" });
  });
});

describe("planEarnDeposit: UPGRADED wrapper (navFloor true) — H-1 refuses while ANY pot is over-impaired", () => {
  it("no repair prefix, ever (B-2: it would move Earn holders' money into the impaired pot)", () => {
    const live = vault(HEALTHY, UNDERWATER, 0, false);
    const up = vault(HEALTHY, UNDERWATER, 0, true);
    expect(prefix(live)).toHaveLength(1); // NEGATIVE CONTROL: the live wrapper still gets it
    expect(prefix(up)).toEqual([]);
    expect(repairUnderwaterPot(up)).toEqual({ state: up, repair: null });
    expect(prefix(up, 1_000n)).toEqual([]); // the 77 path too
  });

  it("sibling over-impaired (SI shape): deposit NOT sent; without the gate it would go out", () => {
    const sp = vault(HEALTHY, UNDERWATER, 0, true);
    expect(planEarnDeposit(sp)).toEqual({ ok: false, reason: "pot-impaired" });
  });

  it("own pot over-impaired: NOT sent", () => {
    expect(planEarnDeposit(vault(UNDERWATER, HEALTHY, 0, true))).toEqual({ ok: false, reason: "pot-impaired" });
  });

  it("healthy vault: own pot, from either registry domain", () => {
    expect(planEarnDeposit(vault(CLEAN, CLEAN, 0, true))).toEqual({ ok: true, domain: 0 });
    expect(planEarnDeposit(vault(CLEAN, CLEAN, 3, true))).toEqual({ ok: true, domain: 3 });
  });

  it("impairment EQUAL to principal is not over-impaired (the program's strict `>`)", () => {
    const edge: DomainState = { ...UNDERWATER, ledger: ledger(1_107_721_000n, 1_107_721_000n, 0n, 1_107_721_000n) };
    expect(potDeficit(syncedLedger(edge))).toBe(0n);
    // ...but the vault is then ~100% impaired, so R-1 pauses it (before the collapse check).
    const sp = vault(edge, { bucket: bucket(1_000n), source: source(1_000n), ledger: ledger(1_000n) }, 0, true, 2_000_000_000_000n);
    expect(planEarnDeposit(sp)).toEqual({ ok: false, reason: "vault-impaired" });
  });
});

describe("share-price collapse gate (H-1 / B-1), both regimes", () => {
  // OTC 6Y4bf live 2026-10-03: d0 available principal 3 atoms, 2,000,000,000 shares.
  const OTC_D0: DomainState = { bucket: bucket(3n), source: source(3n), ledger: ledger(1_000_926_230n, 1_000_926_227n, 0n, 0n) };
  const FRESH_D1: DomainState = { bucket: bucket(0n), source: source(0n), ledger: null };
  it("OTC: NAV 3 vs 2e9 shares -> not sent, live and upgraded", () => {
    for (const navFloor of [false, true]) {
      const sp = vault(OTC_D0, FRESH_D1, 0, navFloor, 2_000_000_000n);
      expect(combinedVault(sp.own, sp.sib, 1000, navFloor)?.nav).toBe(3n);
      // 7c906e45 order: the 10% impairment pause (OTC is ~100% impaired) fires before the collapse check.
      expect(planEarnDeposit(sp)).toEqual({ ok: false, reason: "vault-impaired" });
      // An unimpaired vault at the same NAV / supply: the collapse backstop still refuses it.
      const clean = vault({ ...OTC_D0, ledger: ledger(3n) }, FRESH_D1, 0, navFloor, 2_000_000_000n);
      expect(planEarnDeposit(clean)).toEqual({ ok: false, reason: "price-collapsed" });
    }
  });
  it("boundary: nav * 1000 == shares is allowed, one share more is not", () => {
    const d0: DomainState = { bucket: bucket(5n), source: source(5n), ledger: ledger(5n) };
    expect(planEarnDeposit(vault(d0, FRESH_D1, 0, true, 5n * EARN_PRICE_COLLAPSE_FACTOR))).toEqual({ ok: true, domain: 0 });
    expect(planEarnDeposit(vault(d0, FRESH_D1, 0, true, 5n * EARN_PRICE_COLLAPSE_FACTOR + 1n))).toEqual({ ok: false, reason: "price-collapsed" });
  });
  it("A-1: harvestable LP fees count toward the collapse NAV, exactly as tag 75 prices", () => {
    const d0: DomainState = { bucket: bucket(5n), source: source(5n), ledger: ledger(5n) };
    const shares = 10n * EARN_PRICE_COLLAPSE_FACTOR; // needs NAV >= 10
    const without = vault(d0, FRESH_D1, 0, true, shares);
    expect(planEarnDeposit(without)).toEqual({ ok: false, reason: "price-collapsed" }); // NAV 5
    expect(planEarnDeposit({ ...without, harvestableAtoms: 5n })).toEqual({ ok: true, domain: 0 }); // 5 + 5
    expect(planEarnDeposit({ ...without, harvestableAtoms: 4n })).toEqual({ ok: false, reason: "price-collapsed" });
    // The program's harvestable read underflows (withdrawn > accrued -> 25): don't send.
    expect(planEarnDeposit({ ...without, harvestableAtoms: null })).toEqual({ ok: false, reason: "unpriceable" });
  });
  it("a genesis vault (0 shares) is never 'collapsed'", () => {
    const d0: DomainState = { bucket: bucket(0n), source: source(0n), ledger: null };
    expect(planEarnDeposit(vault(d0, FRESH_D1, 0, true, 0n))).toEqual({ ok: true, domain: 0 });
  });
});

describe("per-pot NAV floor in the maths, only when navFloor (7a3ac04c lp_vault_nav_atoms_floored)", () => {
  const l = syncedLedger(UNDERWATER); // principal 1,000,000,000 vs net impairment 1,107,721,000
  it("availablePrincipal / domainNav: null on the live wrapper (Custom 25), 0 floored", () => {
    expect(availablePrincipal(l)).toBeNull();
    expect(domainNav(l, 1000)).toBeNull();
    expect(availablePrincipal(l, true)).toBe(0n);
    expect(domainNav(l, 1000, true)).toBe(0n);
  });
  it("floored equals unfloored wherever the live program prices (continuity)", () => {
    const h = syncedLedger(HEALTHY);
    expect(availablePrincipal(h, true)).toBe(availablePrincipal(h));
    expect(domainNav(h, 1000, true)).toBe(domainNav(h, 1000));
  });
  it("combinedVault / vaultValue: SI prices on the healthy pot alone once floored", () => {
    expect(combinedVault(HEALTHY, UNDERWATER, 1000)).toBeNull();
    const floored = combinedVault(HEALTHY, UNDERWATER, 1000, true)!;
    // = the healthy pot alone (+ the impaired pot's LP earnings, 0 here).
    expect(floored).toEqual({ nav: domainNav(syncedLedger(HEALTHY), 1000), available: availablePrincipal(syncedLedger(HEALTHY)) });
    // Live: the vault is valued after the app's repair; upgraded: no repair, the impaired pot is 0.
    expect(vaultValue(vault(HEALTHY, UNDERWATER, 0, true))).toEqual(floored);
  });
  it("planSplitPotRedemption: a withdrawal the floored program pays is payable (not null) only when navFloor", () => {
    const base = { own: HEALTHY, sib: UNDERWATER, totalShares: 2_699_885_245n, shares: 1_000_000n, feeShareBps: 1000 };
    expect(planSplitPotRedemption(base)).toBeNull(); // NEGATIVE CONTROL: live wrapper, unpriceable (25)
    const p = planSplitPotRedemption({ ...base, navFloor: true })!;
    expect(p).not.toBeNull();
    expect(p.payable).toBe(true);
    expect(p.maxShares).toBeGreaterThan(0n);
  });
  it("an over-impaired PAYOUT pot cannot pay from itself (available 0) beyond what the sibling top-up brings", () => {
    const p = planSplitPotRedemption({ own: UNDERWATER, sib: HEALTHY_THIN, totalShares: 2_699_885_245n, shares: 2_000_000_000n, feeShareBps: 1000, navFloor: true })!;
    expect(p.payable).toBe(false);
  });
});

describe("R-1 impairment-ratio pause (wrapper 7c906e45 LP_VAULT_MAX_DEPOSIT_IMPAIRMENT_BPS = 1000), both regimes", () => {
  // Pot with principal P and booked loss L (synced: lastObsUnavailable = consumed).
  const pot = (P: bigint, L: bigint): DomainState => ({ bucket: bucket(P - L, L), source: source(P - L), ledger: ledger(P, L, 0n, L) });
  it("constant and exact integer rule: impairment > floor(principal * 1000 / 10_000)", () => {
    expect(EARN_MAX_DEPOSIT_IMPAIRMENT_BPS).toBe(1_000n);
    expect(vaultImpairmentExceeds(100n, 1_000n)).toBe(false); // exactly 10% accepted
    expect(vaultImpairmentExceeds(101n, 1_000n)).toBe(true); // one atom more refused
    expect(vaultImpairmentExceeds(100n, 1_009n)).toBe(false); // floor(100.9) = 100
    expect(vaultImpairmentExceeds(101n, 1_009n)).toBe(true);
    expect(vaultImpairmentExceeds(0n, 0n)).toBe(false); // no backing yet
  });
  it("per pot impairment is min(loss - recovery, principal); recovery above loss reads 0", () => {
    expect(potImpairmentParts(ledger(100n, 250n, 0n, 0n))).toEqual({ principal: 100n, impairment: 100n });
    expect(potImpairmentParts(ledger(100n, 10n, 30n, 0n))).toEqual({ principal: 100n, impairment: 0n });
  });
  for (const navFloor of [false, true]) {
    it(`vault-TOTAL, not per pot (navFloor=${navFloor}): 10% exactly sends, +1 atom pauses`, () => {
      // d0 15% impaired alone, d1 clean -> vault 7.5% -> sends.
      expect(planEarnDeposit(vault(pot(1_000_000_000n, 150_000_000n), CLEAN, 0, navFloor))).toEqual({ ok: true, domain: 0 });
      // exactly 10% of 2,000 tokens = 200 -> sends; 200 + 1 atom -> paused.
      expect(planEarnDeposit(vault(pot(1_000_000_000n, 200_000_000n), CLEAN, 0, navFloor))).toEqual({ ok: true, domain: 0 });
      expect(planEarnDeposit(vault(pot(1_000_000_000n, 200_000_001n), CLEAN, 0, navFloor))).toEqual({ ok: false, reason: "vault-impaired" });
    });
  }
  it("an uninitialised sibling ledger counts as principal 0 (read_or_new)", () => {
    const FRESH: DomainState = { bucket: bucket(0n), source: source(0n), ledger: null };
    expect(planEarnDeposit(vault(pot(1_000_000_000n, 100_000_000n), FRESH, 0, true))).toEqual({ ok: true, domain: 0 });
    expect(planEarnDeposit(vault(pot(1_000_000_000n, 100_000_001n), FRESH, 0, true))).toEqual({ ok: false, reason: "vault-impaired" });
  });
});
