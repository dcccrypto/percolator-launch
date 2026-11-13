// @vitest-environment node
/**
 * Two-pot Earn vault payout. Wrapper 553d76f0 (PR #522): a non-bound 77 pays across both pots by
 * itself, so the app sends 77 alone (the #2764 [91, 77] prefix is gone). A 100% exit can still fail
 * the stay-fully-backed gate (Custom 21), and a pot whose loss exceeds its principal makes every
 * 75 / 77 fail Custom 25 until the reverse-91 repair lands (M-1).
 *
 * SI 2026-10-01 fixture: the cap numbers were checked by simulating on a surfpool fork of devnet as
 * the redeemer 9sM73A (capped 2,597,343,527 -> paid 2,600,140,063; exact cap 2,599,943,471 -> paid
 * 2,602,742,806; full -> Custom 21). The sibling move the program now makes inside 77 is the same
 * 999,967,024 the old 91 moved.
 * Live devnet 2026-10-02 (wrapper 553d76f0), PERC 9EPm8nB8 and SI 8WC8vALs fixtures below:
 *   PERC plain 77 (no 91) sent: TXJhtuDPRKMq...W3icie, paid 9.999807 USDC
 *   PERC [91 drain the payout pot, plain 77]: OK, log `p3_redeem_pot_top_up from=1 to=0`
 *   SI plain 75 -> Custom 25; [91 0->1 107,721,000, 75] -> OK; one atom short -> Custom 25
 *   SI stranger 91 out of the underwater pot (1 atom) -> Custom 25
 */
import { describe, expect, it } from "vitest";
import * as C from "@/lib/limits/constants";
import { Keypair } from "@solana/web3.js";
import {
  EarnPayoutCapError,
  cappedShares,
  combinedVault,
  decodeDomainLedger,
  movablePrincipal,
  planSplitPotRedemption,
  potDeficit,
  repairUnderwaterPot,
  splitPotPrefixIxs,
  syncedLedger,
  vaultValue,
  type DomainState,
  type SplitPotState,
} from "@/lib/limits/earn-split-pot";

const BS = C.BOUND_SCALE;
const ledger = (principal: bigint) => ({
  totalPrincipal: principal, totalEarnings: 0n, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n,
  cumulativeLoss: 0n, cumulativeRecovery: 0n, lastObsUnavailable: 0n,
});
const source = (freshReservedAtoms: bigint, pcbAtoms = 0n) => ({
  positiveClaimBound: pcbAtoms * BS, freshReserved: freshReservedAtoms * BS, validLienedBacking: 0n,
  insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n,
});
const bucket = (freshAtoms: bigint, consumedAtoms = 0n) => ({
  freshUnliened: freshAtoms * BS, validLiened: 0n, consumed: consumedAtoms * BS, impaired: 0n, utilFeeEarnings: 0n, status: 1,
});

// SI, 2026-10-01 (domain 0 = the registry's pot, domain 1 = the sibling).
const SI_OWN: DomainState = { bucket: bucket(1_603_372_739n), source: source(1_603_372_739n, 596_957n), ledger: ledger(1_602_825_164n) };
const SI_SIB: DomainState = { bucket: bucket(1_000_000_002n, 32_976n), source: source(1_000_000_002n), ledger: ledger(1_000_000_000n) };
const TOTAL = 2_599_992_799n;
const HELD = 2_599_991_798n;
const plan = (shares: bigint, own = SI_OWN, sib = SI_SIB) => planSplitPotRedemption({ own, sib, totalShares: TOTAL, shares, feeShareBps: 1000 })!;

describe("split-pot Earn payout (SI live fixture, fork-verified)", () => {
  it("prices both pots like the program: the sibling's 32,976 consumed is net impairment", () => {
    expect(combinedVault(SI_OWN, SI_SIB, 1000)).toEqual({ nav: 2_602_792_188n, available: 2_602_792_188n });
    expect(movablePrincipal(SI_SIB)).toBe(999_967_024n);
  });

  it("refuses the full exit before signing (even with 77's own sibling top-up)", () => {
    const p = plan(HELD);
    // principal 2,602,791,185 > d0 credit room 1,602,775,782 + the sibling's 999,967,024.
    expect(p.payable).toBe(false);
    expect(p.maxShares).toBe(2_599_943_471n);
  });

  it("the capped re-request pays exactly what the fork paid", () => {
    const capped = cappedShares(plan(HELD).maxShares, HELD);
    expect(capped).toBe(2_597_343_527n);
    const p = plan(capped);
    expect(p.payable).toBe(true);
    expect(p.atoms).toBe(2_600_140_063n);
  });

  it("the cap is tight: maxShares pays, one more share does not", () => {
    expect(plan(2_599_943_471n).payable).toBe(true);
    expect(plan(2_599_943_471n).atoms).toBe(2_602_742_806n);
    expect(plan(2_599_943_472n).payable).toBe(false);
  });

  it("a payout the payout pot alone covers is payable", () => {
    expect(plan(1_000_000_000n).payable).toBe(true);
  });

  it("a single-pot vault (empty sibling) pays from its own pot", () => {
    const own: DomainState = { bucket: bucket(2_000_000_000n), source: source(2_000_000_000n), ledger: ledger(2_000_000_000n) };
    const sib: DomainState = { bucket: { ...bucket(0n), status: 0 }, source: source(0n), ledger: null };
    const p = planSplitPotRedemption({ own, sib, totalShares: 2_000_000_000n, shares: 2_000_000_000n, feeShareBps: 1000 })!;
    expect(p.payable).toBe(true);
  });

  it("a missing ledger reads as new_backing_domain_ledger: zero principal, no loss booked", () => {
    const l = syncedLedger({ bucket: bucket(500n, 20n), source: source(500n), ledger: null });
    expect(l.totalPrincipal).toBe(0n);
    expect(l.cumulativeLoss).toBe(0n);
    expect(l.lastObsUnavailable).toBe(20n);
  });

  it("77's earnings gate: the sibling's earnings count once 77 relabels them onto the payout pot", () => {
    // 100 atoms of LP earnings (fee share 10%: 1,000 gross) on the SIBLING's ledger and bucket.
    const sib: DomainState = { ...SI_SIB, bucket: { ...SI_SIB.bucket, utilFeeEarnings: 1_000n }, ledger: { ...ledger(1_000_000_000n), totalEarnings: 1_000n, lastObsBucketEarnings: 1_000n } };
    const p = planSplitPotRedemption({ own: SI_OWN, sib, totalShares: TOTAL, shares: 1_000_000_000n, feeShareBps: 1000 })!;
    expect(p.atoms - p.principal).toBeGreaterThan(0n);
    expect(p.payable).toBe(true);
    // Earnings booked on a ledger with no gross left in either bucket cannot pay.
    const dry: DomainState = { ...SI_SIB, ledger: { ...ledger(1_000_000_000n), totalEarnings: 1_000n } };
    expect(planSplitPotRedemption({ own: SI_OWN, sib: dry, totalShares: TOTAL, shares: 1_000_000_000n, feeShareBps: 1000 })!.payable).toBe(false);
  });

  it("decodes the ledger layout read live (principal, earnings, loss/recovery, watermark)", () => {
    const d = new Uint8Array(80 + 16 * 9);
    const put = (i: number, v: bigint) => new DataView(d.buffer).setBigUint64(80 + i * 16, v, true);
    put(0, 1_602_825_164n); put(3, 7n); put(4, 2n); put(5, 7n); put(6, 30n); put(7, 10n); put(8, 20n);
    expect(decodeDomainLedger(d)).toEqual({
      totalPrincipal: 1_602_825_164n, totalEarnings: 7n, totalEarningsWithdrawn: 2n, lastObsBucketEarnings: 7n,
      cumulativeLoss: 30n, cumulativeRecovery: 10n, lastObsUnavailable: 20n,
    });
    expect(decodeDomainLedger(null)).toBeNull();
  });
});

// ── Live devnet 2026-10-02, wrapper 553d76f0 ──────────────────────────────────────────────────
const PROG = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const REGISTRY = Keypair.generate().publicKey;
const L0 = Keypair.generate().publicKey;
const L1 = Keypair.generate().publicKey;
const synced = (principal: bigint, loss: bigint, recovery: bigint, unavailable: bigint) => ({
  ...ledger(principal), cumulativeLoss: loss, cumulativeRecovery: recovery, lastObsUnavailable: unavailable,
});
const vault = (own: DomainState, sib: DomainState, totalShares: bigint): SplitPotState => ({
  own, sib, ownDomain: 0, totalShares, feeShareBps: 1000, ownLedger: L0, sibLedger: L1,
});
const prefix = (sp: SplitPotState, payoutShares?: bigint) =>
  splitPotPrefixIxs({ programId: PROG, cranker: REGISTRY, market: MARKET, registry: REGISTRY, sp, payoutShares });

// PERC 9EPm8nB8: both pots healthy.
const PERC = vault(
  { bucket: bucket(1_504_271_051n, 7_038_746n), source: source(1_504_271_051n, 1_887_076n), ledger: synced(1_511_115_355n, 7_195_503n, 0n, 7_038_746n) },
  { bucket: bucket(2_191_514_463n, 8_490_966n), source: source(2_191_514_463n, 1_653_873n), ledger: synced(2_200_000_000n, 8_490_966n, 0n, 8_490_966n) },
  3_710_141_707n,
);
// SI 8WC8vALs: d1 lost 1,107.721 against 1,000 principal (trading, no 91 ever touched it).
const SI_LIVE = vault(
  { bucket: bucket(1_083_616_340n, 851_301_283n), source: source(1_083_616_340n, 844_377_403n), ledger: synced(1_703_549_886n, 1_009_226_428n, 157_705_543n, 851_301_283n) },
  { bucket: { ...bucket(0n, 1_107_721_000n), freshUnliened: 1_000_000_000_000n }, source: { ...source(0n, 0n), positiveClaimBound: 2_745_796n * BS, freshReserved: 1_000_000_000_000n }, ledger: synced(1_000_000_000n, 1_107_721_000n, 0n, 1_107_721_000n) },
  2_699_885_245n,
);

describe("553d76f0: 77 pays across both pots, so the app sends 77 alone", () => {
  it("a payout larger than the payout pot is payable with no 91 in front (PERC)", () => {
    const shares = 2_000_000_000n;
    const p = planSplitPotRedemption({ ...PERC, shares })!;
    // principal ~1,992 USDC is more than the payout pot's 1,503.9 available: 77 tops itself up.
    expect(p.principal).toBeGreaterThan(availableOwn(PERC));
    expect(p.payable).toBe(true);
    expect(prefix(PERC, shares)).toEqual([]);
  });

  it("a healthy vault gets no prefix for a deposit either", () => {
    expect(prefix(PERC)).toEqual([]);
    expect(repairUnderwaterPot(PERC)).toEqual({ state: PERC, repair: null });
  });
});

describe("M-1: an underwater pot (loss > principal) is repaired in the user's own transaction", () => {
  it("prices SI as the program does: unpriceable as is, d1 short by exactly 107.721", () => {
    expect(combinedVault(SI_LIVE.own, SI_LIVE.sib, 1000)).toBeNull();
    expect(potDeficit(syncedLedger(SI_LIVE.sib))).toBe(107_721_000n);
    expect(potDeficit(syncedLedger(SI_LIVE.own))).toBe(0n);
  });

  it("plans the reverse 91 from the healthy pot (deficit + 0.1%) and values the vault after it", () => {
    const fixed = repairUnderwaterPot(SI_LIVE)!;
    expect(fixed.repair).toEqual({ fromDomain: 0, toDomain: 1, amount: 107_721_000n + 107_721n + 1n });
    expect(potDeficit(syncedLedger(fixed.state.sib))).toBe(0n);
    // Same holders, both pots: the vault is worth d0's 852.029001 less d1's 107.721 deficit.
    expect(vaultValue(SI_LIVE)).toEqual({ nav: 744_308_001n, available: 744_308_001n });
  });

  it("one atom short of the deficit leaves the pot underwater (live: Custom 25)", () => {
    const fixed = repairUnderwaterPot(SI_LIVE)!;
    const short = { ...fixed.state.sib, ledger: { ...fixed.state.sib.ledger!, totalPrincipal: 1_000_000_000n + 107_721_000n - 1n } };
    expect(potDeficit(syncedLedger(short))).toBe(1n);
  });

  it("the repair is the only instruction in front of a deposit: 91 from d0's ledger into d1's", () => {
    const [ix, ...rest] = prefix(SI_LIVE);
    expect(rest).toEqual([]);
    expect(ix.data[0]).toBe(91);
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset);
    expect([dv.getUint16(1, true), dv.getUint16(3, true)]).toEqual([0, 1]);
    expect(dv.getBigUint64(5, true)).toBe(107_828_722n);
    expect(ix.keys.map((k) => k.pubkey.toBase58()).slice(3, 5)).toEqual([L0.toBase58(), L1.toBase58()]);
  });

  it("the creator's full exit is refused before signing after the repair (live: [91, 77] -> Custom 21)", () => {
    expect(() => prefix(SI_LIVE, 2_599_991_798n)).toThrow(EarnPayoutCapError);
    try { prefix(SI_LIVE, 2_599_991_798n); } catch (e) {
      const cap = e as EarnPayoutCapError;
      expect(cap.maxShares).toBeGreaterThan(0n);
      expect(cap.maxShares).toBeLessThan(2_599_991_798n);
    }
  });

  it("both pots underwater, or too little free principal, is not repairable: nothing is added", () => {
    const both = vault(SI_LIVE.sib, SI_LIVE.sib, SI_LIVE.totalShares);
    expect(repairUnderwaterPot(both)).toBeNull();
    expect(vaultValue(both)).toBeNull();
    expect(prefix(both)).toEqual([]);
    const thin = vault({ ...SI_LIVE.own, source: { ...SI_LIVE.own.source, positiveClaimBound: SI_LIVE.own.source.freshReserved - 100n * BS } }, SI_LIVE.sib, SI_LIVE.totalShares);
    expect(movablePrincipal(thin.own)).toBeLessThan(107_721_000n);
    expect(repairUnderwaterPot(thin)).toBeNull();
  });
});

function availableOwn(sp: SplitPotState): bigint {
  const l = syncedLedger(sp.own);
  return l.totalPrincipal - (l.cumulativeLoss - l.cumulativeRecovery);
}
