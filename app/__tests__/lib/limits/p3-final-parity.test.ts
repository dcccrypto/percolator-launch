// @vitest-environment node
/**
 * P3 end-to-end surface (round 4) against TWO independent oracles:
 *   1. rust-p3-final.json — app/scripts/limits-parity/p3-final/main.rs on the REAL P3 crate
 *      (feat/p3-vault-owned-lp@39b138c8 FINAL senior draw + recall cap, P1 3acb34ae, engine 35ddd692): this module's bytes decoded by
 *      `ix::Instruction::decode`, rustc offset_of!, error ordinals by name, the program's own
 *      `read_asset_vault_lp` at the app's offsets and `registry_vault_lp_bound`;
 *   2. sdk-p3-parity.json — SDK 8.0.0 (9e843e5)'s fixture from its own Rust oracle (at 424fe7e4,
 *      whose program code is identical to the final head for every byte this app sends).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ix from "@/lib/limits/p3-ix";
import * as C from "@/lib/limits/constants";
import { DEFAULT_SLAB_SIZE, slabSizeFor, wizardSlabBytes } from "@/lib/create-market-args";
import { V17_PORTFOLIO_ACCOUNT_LEN, v17MarketAccountLen } from "@percolatorct/sdk";
import { decodeLpVaultRegistryBound } from "@/lib/limits/decode";

const F = join(__dirname, "../../fixtures/limits");
type RustVec = { hex: string; rust: { ok: boolean; decoded?: Record<string, string | number> | null; err?: string } };
const rust = JSON.parse(readFileSync(join(F, "rust-p3-final.json"), "utf8")) as {
  p3Sha: string;
  vectors: Record<string, RustVec>;
  errors: Record<string, number>;
  layout: Record<string, number>;
  assetVaultLpReads: { asset: number; appOffset: number; programReadsSame: boolean; offByOneReadsSame: boolean }[];
  registryBound: { flag: number; bound: boolean | "err" }[];
};
const sdk = JSON.parse(readFileSync(join(F, "sdk-p3-parity.json"), "utf8")) as { p3Sha: string; vectors: Record<string, RustVec> };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;

// The SAME inputs gen-vectors.ts feeds the oracle.
const INPUTS: Record<string, () => Uint8Array> = {
  init_vault_lp_min: () => ix.encodeInitVaultLp(1_000),
  init_vault_lp_max: () => ix.encodeInitVaultLp(10_000),
  deposit_junior: () => ix.encodeDepositJuniorTranche(123_456_789n),
  deposit_junior_u128max: () => ix.encodeDepositJuniorTranche(U128),
  withdraw_junior: () => ix.encodeWithdrawJuniorTranche((1n << 70n) + 5n),
  recall: () => ix.encodeVaultLpRecall(987_654_321n, 3),
  settle_resolved_close: () => ix.encodeVaultLpSettleResolved(0),
  settle_resolved_topup: () => ix.encodeVaultLpSettleResolved(1),
  close_portfolio: () => ix.encodeClosePortfolio(7n, 42n, 3n),
  close_portfolio_max: () => ix.encodeClosePortfolio(U64, U64 - 1n, 1n << 40n),
  close_resolved: () => ix.encodeCloseResolved(0n),
  claim_topup: () => ix.encodeClaimResolvedPayoutTopup(),
  crank_fees_d0: () => ix.encodeLpVaultCrankFees(0),
  crank_fees_d1: () => ix.encodeLpVaultCrankFees(1),
  release_surplus: () => ix.encodeVaultLpReleaseSurplus(60_000_000n, 0),
  release_surplus_max: () => ix.encodeVaultLpReleaseSurplus(U128, 1),
};
const EXPECT_DECODED: Record<string, Record<string, string | number>> = {
  init_vault_lp_min: { tag: C.P3_TAG.InitVaultLp, juniorFloorBps: "1000" },
  init_vault_lp_max: { tag: C.P3_TAG.InitVaultLp, juniorFloorBps: "10000" },
  deposit_junior: { tag: C.P3_TAG.DepositJuniorTranche, amount: "123456789" },
  deposit_junior_u128max: { tag: C.P3_TAG.DepositJuniorTranche, amount: U128.toString() },
  withdraw_junior: { tag: C.P3_TAG.WithdrawJuniorTranche, amount: ((1n << 70n) + 5n).toString() },
  recall: { tag: C.P3_TAG.VaultLpRecall, amount: "987654321", targetDomain: "3" },
  settle_resolved_close: { tag: C.P3_TAG.VaultLpSettleResolved, topup: "0" },
  settle_resolved_topup: { tag: C.P3_TAG.VaultLpSettleResolved, topup: "1" },
  close_portfolio: { tag: C.TAG_CLOSE_PORTFOLIO, portfolioId: "7", expectedSequence: "42", positionEpoch: "3" },
  close_portfolio_max: { tag: C.TAG_CLOSE_PORTFOLIO, portfolioId: U64.toString(), expectedSequence: (U64 - 1n).toString(), positionEpoch: (1n << 40n).toString() },
  close_resolved: { tag: C.TAG_CLOSE_RESOLVED, feeRatePerSlot: "0" },
  claim_topup: { tag: C.TAG_CLAIM_RESOLVED_PAYOUT_TOPUP },
  crank_fees_d0: { tag: C.TAG_LP_VAULT_CRANK_FEES, domain: "0" },
  crank_fees_d1: { tag: C.TAG_LP_VAULT_CRANK_FEES, domain: "1" },
  release_surplus: { tag: C.P3_TAG.VaultLpReleaseSurplus, amount: "60000000", sourceDomain: "0" },
  release_surplus_max: { tag: C.P3_TAG.VaultLpReleaseSurplus, amount: U128.toString(), sourceDomain: "1" },
};

describe("P3 final head: app encoders vs the real ix::Instruction::decode", () => {
  it("fixture is from the FINAL P3 head (4b1a5d30: senior draw, recall cap, pause code 89, on P1 3acb34ae)", () => {
    // Relaunch head 5544302a (all-fresh IDs; error 90 since 592286b4); layout and vectors identical to 4b1a5d30.
    expect(rust.p3Sha).toBe("5544302ad689dd94cff300f50a2964c4a1c07ede");
    expect((rust as unknown as { p1Sha: string }).p1Sha).toBe("3acb34ae83b4038a88a02731d1aa023142ef6c11");
    // SDK 8's fixture was generated at 424fe7e4. Since then tag 94's ACCOUNT list changed twice
    // (path B removed; auto-pin tail [8] matcher / [9] ctx / [10] delegate added in 07a1d0eb) but
    // no instruction DATA did: the bytes compared below (94..101 data) are unchanged.
    expect(sdk.p3Sha).toBe("424fe7e473bec1154eacde1ac8bd7e190b526fd2");
  });
  for (const [id, enc] of Object.entries(INPUTS)) {
    it(`${id}: same bytes, decoded to the same fields`, () => {
      const v = rust.vectors[id];
      expect(v, id).toBeDefined();
      expect(hex(enc())).toBe(v.hex);
      expect(v.rust.ok).toBe(true);
      expect(v.rust.decoded).toEqual(EXPECT_DECODED[id]);
    });
    it(`${id}: a short / long payload is refused by the decoder (exact wire length)`, () => {
      const short = rust.vectors[`${id}__short`];
      if (enc().length > 1) expect(short.rust.ok).toBe(false);
      expect(rust.vectors[`${id}__long`].rust.ok).toBe(false);
    });
  }
  it("every non-control vector in the fixture is covered here", () => {
    expect(Object.keys(rust.vectors).filter((k) => !k.includes("__")).sort()).toEqual(Object.keys(INPUTS).sort());
  });
  it("encoders refuse out-of-range inputs before the program would", () => {
    expect(() => ix.encodeInitVaultLp(999)).toThrow();
    expect(() => ix.encodeInitVaultLp(10_001)).toThrow();
    expect(() => ix.encodeDepositJuniorTranche(-1n)).toThrow();
    expect(() => ix.encodeDepositJuniorTranche(U128 + 1n)).toThrow();
    expect(() => ix.encodeVaultLpRecall(1n, 0x1_0000)).toThrow();
    expect(() => ix.encodeClosePortfolio(U64 + 1n, 0n, 0n)).toThrow();
  });
});

describe("P3 final head: cross-check against SDK 8.0.0's own Rust-verified bytes", () => {
  const cases: [string, () => Uint8Array][] = [
    ["initVaultLp_min", () => ix.encodeInitVaultLp(1_000)],
    ["initVaultLp_max", () => ix.encodeInitVaultLp(10_000)],
    ["depositJunior", () => ix.encodeDepositJuniorTranche(1_000_000_000_000_000_000_000n)],
    ["withdrawJunior", () => ix.encodeWithdrawJuniorTranche(1n)],
    ["recall", () => ix.encodeVaultLpRecall(U128, 1)],
    ["settleResolved_close", () => ix.encodeVaultLpSettleResolved(0)],
    ["settleResolved_topup", () => ix.encodeVaultLpSettleResolved(1)],
  ];
  for (const [id, enc] of cases) {
    it(id, () => {
      expect(sdk.vectors[id].rust.ok).toBe(true);
      expect(hex(enc())).toBe(sdk.vectors[id].hex);
    });
  }
});

describe("P3 final head: layout (rustc offset_of!) and errors (by name)", () => {
  const L = rust.layout;
  it("engine header fields the resolved exit reads", () => {
    expect(C.MARKET_GROUP_OFF).toBe(L.marketGroupOff);
    expect(C.H_C_TOT).toBe(L["hdr.c_tot"]);
    expect(C.H_MATERIALIZED_PORTFOLIO_COUNT).toBe(L["hdr.materialized_portfolio_count"]);
    expect(C.H_MODE).toBe(L["hdr.mode"]);
    expect(C.H_RESOLVED_SLOT).toBe(L["hdr.resolved_slot"]);
    expect(C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS).toBe(L["wcfg.force_close_delay_slots"]);
    expect(C.HEADER_LEN).toBe(L["wcfg.marketauth"]);
  });
  it("F-14 terminal backing fields (residual + physical idle backing the junior's 102 reads)", () => {
    expect(C.H_BACKING_PROVIDER_EARNINGS_TOTAL).toBe(L["hdr.backing_provider_earnings_total"]);
    expect(C.H_SOURCE_FRESH_BACKING_TOTAL_NUM).toBe(L["hdr.source_fresh_backing_total_num"]);
    expect(C.SLOT_BACKING_LONG).toBe(L["slot.backing_long"]);
    expect(C.SLOT_BACKING_SHORT).toBe(L["slot.backing_short"]);
    expect(C.BUCKET_FRESH_UNLIENED_BACKING_NUM).toBe(L["bucket.fresh_unliened_backing_num"]);
    expect(C.BOUND_SCALE).toBe(10n ** BigInt(L.boundScaleLog10));
  });
  it("F14-Q2: every wizard launch (P3 and legacy) is the program's ONE-slot length; the 14-slot length stays the program's for existing markets", () => {
    expect(slabSizeFor({ p3: {} })).toBe(L.marketAccountLen1);
    expect(slabSizeFor({})).toBe(L.marketAccountLen1);
    expect(wizardSlabBytes(true)).toBe(L.marketAccountLen1);
    expect(wizardSlabBytes(false)).toBe(L.marketAccountLen1);
    expect(v17MarketAccountLen(1)).toBe(L.marketAccountLen1);
    expect(DEFAULT_SLAB_SIZE).toBe(L.marketAccountLen1);
    expect(v17MarketAccountLen(14)).toBe(L.marketAccountLen14);
    expect(V17_PORTFOLIO_ACCOUNT_LEN).toBe(L.portfolioAccountLen);
  });
  it("portfolio fields (emptiness subset + payout receipt)", () => {
    const h = C.HEADER_LEN;
    expect(C.PF_OWNER).toBe(h + L["pf.owner"]);
    expect(C.PF_CAPITAL).toBe(h + L["pf.capital"]);
    expect(C.PF_PNL).toBe(h + L["pf.pnl"]);
    expect(C.PF_RESERVED_PNL).toBe(h + L["pf.reserved_pnl"]);
    expect(C.PF_FEE_CREDITS).toBe(h + L["pf.fee_credits"]);
    expect(C.PF_CANCEL_DEPOSIT_ESCROW).toBe(h + L["pf.cancel_deposit_escrow"]);
    expect(C.PF_ACTIVE_BITMAP).toBe(h + L["pf.active_bitmap"]);
    expect(C.PF_REBALANCE_LOCK).toBe(h + L["pf.rebalance_lock"]);
    expect(C.PF_LIQUIDATION_LOCK).toBe(h + L["pf.liquidation_lock"]);
    expect(C.PF_RESOLVED_PAYOUT_RECEIPT).toBe(h + L["pf.resolved_payout_receipt"]);
    expect(C.RECEIPT_PRESENT).toBe(L["receipt.present"]);
    expect(C.RECEIPT_FINALIZED).toBe(L["receipt.finalized"]);
  });
  it("registry + vault-LP state + per-asset record", () => {
    expect(C.REG_TOTAL_LP_SHARES_OUTSTANDING).toBe(L["reg.total_lp_shares_outstanding"]);
    expect(C.REG_DOMAIN).toBe(L["reg.domain"]);
    expect(C.REG_VAULT_LP_BOUND_FLAG).toBe(L["reg.bound_flag"]);
    expect(C.VS.juniorOwner).toBe(L["vs.junior_owner"]);
    expect(C.VS.lpPortfolio).toBe(L["vs.lp_portfolio"]);
    expect(C.VS.seniorClaimAtoms).toBe(L["vs.senior_claim_atoms"]);
    expect(C.VS.juniorDepositedAtoms).toBe(L["vs.junior_deposited_atoms"]);
    expect(C.VS.juniorFloorBps).toBe(L["vs.junior_floor_bps"]);
    // d119eebd senior draw ("Earn absorbed" on the Earn page)
    expect(C.VS.seniorFeeShareBps).toBe(L["vs.senior_fee_share_bps"]);
    expect(C.VS.seniorDrawnAtoms).toBe(L["vs.senior_drawn_atoms"]);
    expect(C.VS.seniorDrawOutstandingAtoms).toBe(L["vs.senior_draw_outstanding_atoms"]);
    expect(C.VAULT_LP_STATE_ACCOUNT_LEN).toBe(L["vs.account_len"]);
    expect(C.AV_APPROVED_MATCHER_PROGRAM).toBe(L["av.approved_matcher_program"]);
    expect(C.AV_FLAGS).toBe(L["av.flags"]);
    expect(C.ASSET_VAULT_LP_OFF).toBe(L.assetVaultLpOff);
    expect(C.VAULT_LP_MIN_JUNIOR_FLOOR_BPS).toBe(L.minJuniorFloorBps);
    expect(C.VAULT_LP_MAX_JUNIOR_FLOOR_BPS).toBe(L.maxJuniorFloorBps);
  });
  it("auto-pin (07a1d0eb): the protocol pin the app shows read-only, and the canonical matcher", () => {
    expect(L["pin.kind"]).toBe(C.PIN.kind);
    expect(L["pin.tradingFeeBps"]).toBe(C.PIN.tradingFeeBps);
    expect(L["pin.baseSpreadBps"]).toBe(C.PIN.baseSpreadBps);
    expect(L["pin.maxTotalBps"]).toBe(C.PIN.maxTotalBps);
    expect(L["pin.impactKBps"]).toBe(C.PIN.impactKBps);
    expect(BigInt(L["pin.maxFillUsd"])).toBe(C.PIN.maxFillUsd);
    expect(BigInt(L["pin.maxInventoryUsd"])).toBe(C.PIN.maxInventoryUsd);
    expect(BigInt(L["pin.liquidityUsd"])).toBe(C.PIN.liquidityUsd);
    // the oracle compares the program's constant to this exact string
    expect(C.CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET).toBe("EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX");
    expect(L.canonicalMatcherIsDevnetEDKK).toBe(1);
  });
  it("the program's read_asset_vault_lp reads each asset's record at the app's offset (and not 1 off)", () => {
    expect(rust.assetVaultLpReads).toHaveLength(4);
    for (const r of rust.assetVaultLpReads) {
      expect(r.appOffset).toBe(C.assetWrapperOff(r.asset) + C.ASSET_VAULT_LP_OFF);
      expect(r.programReadsSame).toBe(true);
      expect(r.offByOneReadsSame).toBe(false);
    }
  });
  it("registry_vault_lp_bound: 0 unbound, 1 bound, anything else refused (the app says 'invalid')", () => {
    for (const r of rust.registryBound) {
      const d = new Uint8Array(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
      d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
      d[C.REG_VAULT_LP_BOUND_FLAG] = r.flag;
      expect(decodeLpVaultRegistryBound(d)).toBe(r.bound === "err" ? "invalid" : r.bound);
    }
  });
  it("every P3 error ordinal matches the enum by name; P1 68/69 and the resolved-exit codes too", () => {
    for (const [name, code] of Object.entries(C.P3_ERR)) expect(rust.errors[name], name).toBe(code);
    expect(rust.errors.LpExposureCapExceeded).toBe(C.P1_ERR.LpExposureCapExceeded);
    expect(rust.errors.LpFloorHalt).toBe(C.P1_ERR.LpFloorHalt);
    expect(rust.errors.EngineLockActive).toBe(21);
    expect(rust.errors.ExpectedSigner).toBe(6);
    expect(rust.errors.Unauthorized).toBe(8);
  });
});
