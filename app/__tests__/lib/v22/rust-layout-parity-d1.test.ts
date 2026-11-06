// @vitest-environment node
/**
 * D-1 regression guard (audit 2026-10-17): every offset / width the app's v2.2 decoders use is checked against the
 * DEPLOYED Rust structs, not against another TS table.
 *
 * Ground truth: `__tests__/fixtures/v22-rust-layout-aca02ba6.json`, rustc `offset_of!` / `size_of!` of the structs in
 * percolator-prog aca02ba6 (wrapper 6kpg2wi7, deployed 2026-10-15) built against its path-dep engine percolator 3ce4cbd1,
 * plus the wrapper constants (VERSION, *_LEN, *_OFF, KIND_*). StakePool (percolator-stake 53f5480) is the repr(C)
 * natural-alignment layout of src/state.rs (its main offsets are also const-asserted there). Regenerate with
 * `scripts/v22-layout-probe` when a program or engine deploy moves a struct; this test then names every stale offset.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fx from "../../fixtures/v22-rust-layout-aca02ba6.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { BOND_POSITION_FIELD_OFF_V22, BOND_TRANCHE_FIELD_OFF_V22, INSURANCE_UNITS_FIELD_OFF_V22 } from "@/lib/v22/sdk/v22-state";
import {
  BACKING_BUCKET_FIELD_OFF_P2B,
  BACKING_DOMAIN_LEDGER_FIELD_OFF_P2B,
  SOURCE_CREDIT_FIELD_OFF_P2B,
  SOURCE_CREDIT_LEN_P2B,
  VAULT_LP_EXT_FIELD_OFF_P2B,
  P2B_SENIOR_FLOOR_RECORD_OFF,
  P2B_SENIOR_FLOOR_SLOT_OFF,
} from "@/lib/v22/sdk/records/p2b-earn-abi";
import { ADL_EPISODE_FIELD_OFF } from "@/lib/v22/sdk/records/p2b-lock-exits";
import { ASSET_RISK_LIMITS_FIELD_OFF_P1, ASSET_RISK_LIMITS_LEN_P1, ASSET_RISK_LIMITS_SLOT_OFF_P1 } from "@/lib/v22/sdk/records/risk-limits-p1";
import { ASSET_GROWTH_DEPTH_FIELD_OFF, ASSET_GROWTH_FIELD_OFF, ASSET_GROWTH_LEGACY_FIELD_OFF } from "@/lib/v22/sdk/records/growth-v19";
import { ASSET_GROWTH_DEPTH_FIELD_OFF as R2_ASSET_GROWTH_DEPTH_FIELD_OFF, ASSET_GROWTH_FIELD_OFF as R2_ASSET_GROWTH_FIELD_OFF } from "@/lib/v22/sdk/records/growth-v19-r2";
import growthCtl from "../../fixtures/v22-rust-growth-layout-3198539a.json";
import { ASSET_VAULT_LP_DRAW_LEN_P3, ASSET_VAULT_LP_DRAW_SLOT_OFF_P3, ASSET_VAULT_LP_FIELD_OFF_P3, ASSET_VAULT_LP_P2B_FLAGS_OFF_P3, VAULT_LP_STATE_OFF_P3 } from "@/lib/v22/sdk/records/p3-vault-lp";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, STAKE_POOL_VERSION_V5 } from "@/lib/v22/sdk/v22-stake";
import * as C from "@/lib/limits/constants";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { portfolioLegGeometry } from "@/lib/v22/layout";
import { OP_NEXT_PORTFOLIO_ID } from "@/lib/first-trade";

type Offsets = Record<string, Record<string, number>>;
const OFF = fx.offsets as unknown as Offsets;
const SIZE = fx.sizes as unknown as Record<string, number>;
const K = fx.consts as unknown as Record<string, number>;
const H = K.HEADER_LEN;

/** Rust offset of `struct.field`; throws (fails the test) when the fixture has no such field. */
function rs(struct: string, field: string): number {
  const v = OFF[struct]?.[field];
  if (v === undefined) throw new Error(`fixture has no ${struct}.${field}`);
  return v;
}
/** Every TS key maps to a Rust field (camelCase -> snake_case unless overridden), offset + `base` must match. */
function expectTable(ts: Record<string, number>, struct: string, opts: { base?: number; rename?: Record<string, string>; skip?: string[] } = {}): void {
  const base = opts.base ?? 0;
  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(ts)) {
    if (opts.skip?.includes(k)) continue;
    const field = opts.rename?.[k] ?? k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const want = rs(struct, field) + base;
    if (v !== want) mismatches.push(`${k} (${struct}.${field}): TS ${v} != Rust ${want}`);
  }
  expect(mismatches).toEqual([]);
}

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("D-1 parity: the fixture is the deployed set", () => {
  it("wrapper VERSION 19, engine discriminator 20 (engine #299, fixture hand-patched), the v2.2 sizes", () => {
    expect(K.VERSION).toBe(19);
    expect(K.V16_LAYOUT_DISCRIMINATOR).toBe(20);
    expect(K.PORTFOLIO_ACCOUNT_LEN).toBe(10607);
    expect(K.MARKET_ASSET_SLOT_LEN).toBe(2661);
    expect(SIZE.Market1024).toBe(K.MARKET_ASSET_SLOT_LEN);
  });
});

describe("D-1 parity: LAYOUT_V22 (lib/v22/sdk/layout.ts) vs rustc", () => {
  const L = LAYOUT_V22;
  it("header, config, group, slot and portfolio lengths", () => {
    expect(L.version).toBe(K.VERSION);
    expect(L.engineDiscriminator).toBe(K.V16_LAYOUT_DISCRIMINATOR);
    expect(L.headerLen).toBe(K.HEADER_LEN);
    expect(L.wrapperConfigLen).toBe(K.WRAPPER_CONFIG_LEN);
    expect(L.wrapperConfigLen).toBe(SIZE.WrapperConfigV16);
    expect(L.marketGroupOff).toBe(K.MARKET_GROUP_OFF);
    expect(L.marketGroupLen).toBe(K.MARKET_GROUP_LEN);
    expect(L.assetSlotStride).toBe(K.MARKET_ASSET_SLOT_LEN);
    expect(L.wrapperSlotLen).toBe(K.ASSET_ORACLE_WRAPPER_LEN);
    expect(L.engineSlotLen).toBe(SIZE.EngineAssetSlotV16Account);
    expect(L.assetStateLen).toBe(SIZE.AssetStateV16Account);
    expect(L.portfolio.accountLen).toBe(K.PORTFOLIO_ACCOUNT_LEN);
    expect(L.bandRent?.configLen).toBe(SIZE.V16ConfigAccount);
  });
  it("market-group header offsets", () => {
    expectTable(L.group as unknown as Record<string, number>, "MarketGroupV16HeaderAccount", { rename: { maxMarketSlotsInConfig: "__cfg" }, skip: ["maxMarketSlotsInConfig"] });
    expect(L.group.maxMarketSlotsInConfig).toBe(rs("V16ConfigAccount", "max_market_slots"));
  });
  it("asset-state and engine-slot offsets", () => {
    expectTable(L.assetState as unknown as Record<string, number>, "AssetStateV16Account");
    expectTable(L.engineSlot as unknown as Record<string, number>, "EngineAssetSlotV16Account");
  });
  it("wrapper-slot prefix records", () => {
    const W = L.wrapperSlot;
    expect(W.oracleProfile).toBe(0);
    expect(W.controlSequences).toBe(K.ASSET_CONTROL_SEQUENCES_OFF);
    expect(W.riskLimits).toBe(K.ASSET_RISK_LIMITS_OFF);
    expect(W.growth).toBe(K.ASSET_GROWTH_OFF);
    expect(W.vaultLpDraw).toBe(K.ASSET_VAULT_LP_DRAW_OFF);
    expect(W.vaultLp).toBe(K.ASSET_VAULT_LP_OFF);
    // lot_exp / p4_flags live in AssetOracleProfileV16::_padding0[0] / [1] (v16_program.rs:793 / :804).
    expect(W.profileLotExp).toBe(rs("AssetOracleProfileV16", "_padding0"));
    expect(W.profileP4Flags).toBe(rs("AssetOracleProfileV16", "_padding0") + 1);
  });
  it("portfolio geometry and every leg field", () => {
    const P = L.portfolio;
    expect(P.legStride).toBe(SIZE.PortfolioLegV16Account);
    expect(P.legsOff).toBe(H + rs("PortfolioAccountV16Account", "legs"));
    expect(P.sourceDomainsOff).toBe(H + rs("PortfolioAccountV16Account", "source_domains"));
    expect(P.sourceDomainStride).toBe(SIZE.PortfolioSourceDomainV16Account);
    expect(P.sourceDomainCap).toBe((rs("PortfolioAccountV16Account", "health_cert") - rs("PortfolioAccountV16Account", "source_domains")) / SIZE.PortfolioSourceDomainV16Account);
    expect(P.legCount).toBe((rs("PortfolioAccountV16Account", "source_domains") - rs("PortfolioAccountV16Account", "legs")) / SIZE.PortfolioLegV16Account);
    expect(P.matcherConfigOff).toBe(H + SIZE.PortfolioAccountV16Account);
    expect(P.resolvedPayoutReceiptOff).toBe(H + rs("PortfolioAccountV16Account", "resolved_payout_receipt"));
    expect(P.provenanceVersionOff).toBe(H + rs("ProvenanceHeaderV16Account", "version"));
    expect(P.provenanceDiscriminatorOff).toBe(H + rs("ProvenanceHeaderV16Account", "layout_discriminator"));
    expect(P.accountLen).toBe(H + SIZE.PortfolioAccountV16Account + SIZE.PortfolioMatcherConfigV16 + P.identityTrailerLen);
    expectTable(P.leg as unknown as Record<string, number>, "PortfolioLegV16Account");
  });
  it("band / rent offsets (config, asset state, growth, vault LP)", () => {
    const B = L.bandRent!;
    expectTable(B.config as unknown as Record<string, number>, "V16ConfigAccount");
    expectTable(B.assetState as unknown as Record<string, number>, "AssetStateV16Account");
    expectTable(B.growth as unknown as Record<string, number>, "AssetGrowthV19");
    expectTable(B.vaultLp as unknown as Record<string, number>, "AssetVaultLpV18");
  });
  it("standalone account body lengths", () => {
    const A = L.accounts;
    expect(A.headerLen).toBe(K.HEADER_LEN);
    expect(A.redemptionBody).toBe(SIZE.LpRedemptionV16);
    expect(A.redemptionExtBody).toBe(SIZE.LpRedemptionExtV22);
    expect(A.bondTrancheBody).toBe(SIZE.BondTrancheV20);
    expect(A.bondPositionBody).toBe(SIZE.BondPositionV20);
    expect(A.insuranceUnitsBody).toBe(SIZE.InsuranceUnitsV20);
    expect(A.g9FeedAllowlistBody).toBe(SIZE.G9FeedAllowlistV22);
    expect(A.g9FeedAllowlistCap).toBe((rs("G9FeedAllowlistV22", "owners") - rs("G9FeedAllowlistV22", "keys")) / 32);
  });
  it("account kind bytes", () => {
    const want: Record<keyof typeof ACCOUNT_KIND, string> = {
      Market: "KIND_MARKET", Portfolio: "KIND_PORTFOLIO", BackingDomainLedger: "KIND_BACKING_DOMAIN_LEDGER", InsuranceLedger: "KIND_INSURANCE_LEDGER",
      LpVaultRegistry: "KIND_LP_VAULT_REGISTRY", LpRedemption: "KIND_LP_REDEMPTION", NftRegistry: "KIND_NFT_REGISTRY", ClosedMarket: "KIND_CLOSED_MARKET",
      VaultLpState: "KIND_VAULT_LP_STATE", VaultLpExt: "KIND_VAULT_LP_EXT", BondTranche: "KIND_BOND_TRANCHE", BondPosition: "KIND_BOND_POSITION",
      InsuranceUnits: "KIND_INSURANCE_UNITS", G9FeedAllowlist: "KIND_G9_FEED_ALLOWLIST",
    };
    for (const [k, c] of Object.entries(want)) expect([k, ACCOUNT_KIND[k as keyof typeof ACCOUNT_KIND]]).toEqual([k, K[c]]);
  });
});

describe("D-1 parity: SDK record field tables vs rustc", () => {
  it("bond tranche / bond position / insurance units (v22-state.ts)", () => {
    expectTable(BOND_TRANCHE_FIELD_OFF_V22, "BondTrancheV20", { rename: { cBAtoms: "c_b_atoms", bondCapBpsOfC: "bond_cap_bps_of_c", padding: "_padding" } });
    expectTable(BOND_POSITION_FIELD_OFF_V22, "BondPositionV20", { rename: { padding: "_padding", reserved: "_reserved" } });
    expectTable(INSURANCE_UNITS_FIELD_OFF_V22, "InsuranceUnitsV20", { rename: { padding: "_padding", g9EpochDrawnAtoms: "g9_epoch_drawn_atoms", g9PendingSlot: "g9_pending_slot", g9Epoch: "g9_epoch" } });
  });
  it("vault-LP ext, backing ledger, source credit, backing bucket (p2b-earn-abi.ts)", () => {
    expectTable(VAULT_LP_EXT_FIELD_OFF_P2B, "VaultLpExtV19", { rename: { padding: "_padding", reserved: "_reserved" } });
    expectTable(BACKING_DOMAIN_LEDGER_FIELD_OFF_P2B, "BackingDomainLedgerAccountV16", { rename: { padding: "_padding" } });
    expectTable(SOURCE_CREDIT_FIELD_OFF_P2B, "SourceCreditStateV16Account");
    expect(SOURCE_CREDIT_LEN_P2B).toBe(SIZE.SourceCreditStateV16Account);
    expectTable(BACKING_BUCKET_FIELD_OFF_P2B, "BackingBucketV16Account");
    expect(P2B_SENIOR_FLOOR_RECORD_OFF).toBe(rs("AssetRiskLimitsV17", "p2b_senior_floor_code"));
    expect(P2B_SENIOR_FLOOR_SLOT_OFF).toBe(K.ASSET_RISK_LIMITS_OFF + rs("AssetRiskLimitsV17", "p2b_senior_floor_code"));
  });
  it("risk limits + ADL episode (risk-limits-p1.ts, p2b-lock-exits.ts)", () => {
    expectTable(ASSET_RISK_LIMITS_FIELD_OFF_P1, "AssetRiskLimitsV17", { rename: { reserved0: "_reserved0", reserved: "p2b_senior_floor_code" } });
    expect(ASSET_RISK_LIMITS_LEN_P1).toBe(SIZE.AssetRiskLimitsV17);
    expect(ASSET_RISK_LIMITS_SLOT_OFF_P1).toBe(K.ASSET_RISK_LIMITS_OFF);
    expectTable(ADL_EPISODE_FIELD_OFF, "AssetRiskLimitsV17", {
      rename: { maxEpisodeSlots: "adl_max_episode_slots", sinceSlot: "adl_episode_since_slot", epochKeyLong: "adl_episode_epoch_long", epochKeyShort: "adl_episode_epoch_short" },
    });
  });
  it("growth record incl. the v2.2 depth / tier fields: the round-2 port (growth-v19-r2.ts) vs the DEPLOYED struct", () => {
    expectTable(R2_ASSET_GROWTH_FIELD_OFF, "AssetGrowthV19", { rename: { lLaunchX100: "l_launch_x100", lTierX100: "l_tier_x100", ceilX100: "ceil_x100", reserved: "rent_kink_bps" } });
    expectTable(R2_ASSET_GROWTH_DEPTH_FIELD_OFF, "AssetGrowthV19", { rename: { depthE6: "depth_e6", depthPrevE6: "depth_prev_e6", depthLastGoodE6: "depth_last_good_e6", collateralDecimalsP1: "collateral_decimals_p1", tierLeverageX100: "tier_leverage_x100", depthRiseSlot64: "depth_rise_slot64_le" } });
    // the controller port reads a legacy (flags 0) record through its legacy table: the same deployed bytes
    expectTable(ASSET_GROWTH_LEGACY_FIELD_OFF, "AssetGrowthV19");
  });
  it("growth record: the controller / continuous-leverage port (growth-v19.ts) vs rustc offset_of! at percolator-prog 3198539a", () => {
    const ctl = growthCtl.offsets as Record<string, number>;
    const mism: string[] = [];
    const check = (ts: Record<string, number>, rename: Record<string, string>): void => {
      for (const [k, v] of Object.entries(ts)) {
        const f = rename[k] ?? k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
        if (ctl[f] !== v) mism.push(`${k} (${f}): TS ${v} != Rust ${ctl[f]}`);
      }
    };
    check(ASSET_GROWTH_FIELD_OFF, { volVarX100: "vol_var_x100_le", rentStamp64: "rent_stamp64_le", lLaunchX100: "l_launch_x100", lTierX100: "l_tier_x100", ceilX100: "ceil_x100", depthTwCur: "depth_tw_cur_le", depthTwPrev: "depth_tw_prev_le", reserved: "rent_kink_bps" });
    check(ASSET_GROWTH_DEPTH_FIELD_OFF, { depthE6: "depth_e6", depthPrevE6: "depth_prev_e6", depthLastGoodE6: "depth_last_good_e6", collateralDecimalsP1: "collateral_decimals_p1", tierLeverageX100: "tier_leverage_x100", depthRiseSlot64: "depth_rise_slot64_le", depthTwBucket: "depth_tw_bucket_le" });
    expect(mism).toEqual([]);
    expect(growthCtl.size).toBe(120);
  });
  it("vault-LP state (absolute, +16 header) and per-asset vault LP / draw (p3-vault-lp.ts)", () => {
    // Byte 232 is `backstop_outstanding_atoms` (G9 lent insurance, u64), not padding (finding S3-D1a, fixed).
    expect(VAULT_LP_STATE_OFF_P3.backstopOutstandingAtoms).toBe(H + rs("VaultLpStateV18", "backstop_outstanding_atoms"));
    expect("padding" in VAULT_LP_STATE_OFF_P3).toBe(false);
    expectTable(VAULT_LP_STATE_OFF_P3, "VaultLpStateV18", { base: H });
    expectTable(ASSET_VAULT_LP_FIELD_OFF_P3, "AssetVaultLpV18", { rename: { reserved0: "p2b_flags" } });
    expect(ASSET_VAULT_LP_P2B_FLAGS_OFF_P3).toBe(rs("AssetVaultLpV18", "p2b_flags"));
    expect(ASSET_VAULT_LP_DRAW_SLOT_OFF_P3).toBe(K.ASSET_VAULT_LP_DRAW_OFF);
    expect(ASSET_VAULT_LP_DRAW_LEN_P3).toBe(SIZE.AssetVaultLpDrawV18);
  });
  it("stake pool v5 (v22-stake.ts) vs percolator-stake StakePool and the wrapper's STAKE_POOL_* pins", () => {
    expectTable(STAKE_POOL_FIELD_OFF_V5, "StakePool", { rename: { reserved: "_reserved", v5Reserved: "_v5_reserved" }, skip: ["version"] });
    expect(STAKE_POOL_FIELD_OFF_V5.version).toBe(rs("StakePool", "_reserved") + 8);
    expect(STAKE_POOL_FIELD_OFF_V5.version).toBe(K.STAKE_POOL_OFF_VERSION);
    expect(STAKE_POOL_FIELD_OFF_V5.vault).toBe(K.STAKE_POOL_OFF_VAULT);
    expect(STAKE_POOL_FIELD_OFF_V5.riskMode).toBe(K.STAKE_POOL_OFF_RISK_MODE);
    expect(STAKE_POOL_SIZE_V5).toBe(SIZE.StakePool);
    expect(STAKE_POOL_SIZE_V5).toBe(K.STAKE_POOL_LEN);
    expect(STAKE_POOL_VERSION_V5).toBe(K.STAKE_POOL_VERSION);
  });
});

/** A synthetic VERSION-19 market account header (only the bytes resolveLayout reads). */
function v22MarketBytes(): Uint8Array {
  const d = new Uint8Array(K.MARKET_GROUP_OFF + K.MARKET_GROUP_LEN + K.MARKET_ASSET_SLOT_LEN);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, K.VERSION, true);
  d[10] = ACCOUNT_KIND.Market;
  return d;
}
function v22PortfolioBytes(): Uint8Array {
  const d = new Uint8Array(K.PORTFOLIO_ACCOUNT_LEN);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, K.VERSION, true);
  d[10] = ACCOUNT_KIND.Portfolio;
  v.setUint16(H + rs("ProvenanceHeaderV16Account", "version"), 1, true);
  v.setUint16(H + rs("ProvenanceHeaderV16Account", "layout_discriminator"), K.V16_LAYOUT_DISCRIMINATOR, true);
  return d;
}

describe("D-1 parity: the app's own v2.1-relative constants (lib/limits/constants.ts) after the v2.2 shift", () => {
  it("market header fields through marketOffsets().hdr()", () => {
    const M = marketOffsets(v22MarketBytes());
    const G = K.MARKET_GROUP_OFF;
    const pairs: Array<[string, number, string]> = [
      ["H_CONFIG", C.H_CONFIG, "config"], ["H_CURRENT_SLOT", C.H_CURRENT_SLOT, "current_slot"], ["H_MODE", C.H_MODE, "mode"],
      ["H_VAULT", C.H_VAULT, "vault"], ["H_INSURANCE", C.H_INSURANCE, "insurance"], ["H_C_TOT", C.H_C_TOT, "c_tot"],
      ["H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL", C.H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL, "source_insurance_credit_reserved_total_atoms"],
      ["H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL", C.H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL, "insurance_domain_budget_remaining_total"],
      ["H_RISK_EPOCH", C.H_RISK_EPOCH, "risk_epoch"], ["H_ASSET_SET_EPOCH", C.H_ASSET_SET_EPOCH, "asset_set_epoch"],
      ["H_ORACLE_EPOCH", C.H_ORACLE_EPOCH, "oracle_epoch"], ["H_FUNDING_EPOCH", C.H_FUNDING_EPOCH, "funding_epoch"],
      ["H_MATERIALIZED_PORTFOLIO_COUNT", C.H_MATERIALIZED_PORTFOLIO_COUNT, "materialized_portfolio_count"], ["H_RESOLVED_SLOT", C.H_RESOLVED_SLOT, "resolved_slot"],
    ];
    const bad = pairs.filter(([, rel, f]) => M.hdr(rel) - G !== rs("MarketGroupV16HeaderAccount", f)).map(([n, rel, f]) => `${n}: ${M.hdr(rel) - G} != ${rs("MarketGroupV16HeaderAccount", f)} (${f})`);
    expect(bad).toEqual([]);
    // Config-internal fields do not move (CFG_* are relative to the config start).
    expect(C.CFG_MAINTENANCE_MARGIN_BPS).toBe(rs("V16ConfigAccount", "maintenance_margin_bps"));
    expect(C.CFG_INITIAL_MARGIN_BPS).toBe(rs("V16ConfigAccount", "initial_margin_bps"));
    expect(C.CFG_MAX_TRADING_FEE_BPS).toBe(rs("V16ConfigAccount", "max_trading_fee_bps"));
    expect(C.CFG_MAX_ABS_FUNDING_E9_PER_SLOT).toBe(rs("V16ConfigAccount", "max_abs_funding_e9_per_slot"));
    expect(M.wrapperOff(1) - M.wrapperOff(0)).toBe(K.MARKET_ASSET_SLOT_LEN);
    expect(M.engineOff(0) - M.wrapperOff(0)).toBe(K.ASSET_ORACLE_WRAPPER_LEN);
  });
  it("engine-slot fields through slotRel() and asset-state constants", () => {
    const M = marketOffsets(v22MarketBytes());
    expect(M.slotRel(C.A_RAW_ORACLE_TARGET_PRICE)).toBe(rs("AssetStateV16Account", "raw_oracle_target_price"));
    expect(M.slotRel(C.A_EFFECTIVE_PRICE)).toBe(rs("AssetStateV16Account", "effective_price"));
    expect(M.slotRel(C.A_A_LONG)).toBe(rs("AssetStateV16Account", "a_long"));
    expect(M.slotRel(C.A_A_SHORT)).toBe(rs("AssetStateV16Account", "a_short"));
    expect(M.slotRel(C.A_OI_EFF_LONG_Q)).toBe(rs("AssetStateV16Account", "oi_eff_long_q"));
    expect(M.slotRel(C.A_OI_EFF_SHORT_Q)).toBe(rs("AssetStateV16Account", "oi_eff_short_q"));
    expect(M.slotRel(C.A_EPOCH_LONG)).toBe(rs("AssetStateV16Account", "epoch_long"));
    expect(M.slotRel(C.A_EPOCH_SHORT)).toBe(rs("AssetStateV16Account", "epoch_short"));
    expect(M.slotRel(C.A_MODE_LONG)).toBe(rs("AssetStateV16Account", "mode_long"));
    expect(M.slotRel(C.A_MODE_SHORT)).toBe(rs("AssetStateV16Account", "mode_short"));
  });
  it("wrapper config, oracle profile, risk limits and vault-LP record constants", () => {
    expect(C.WCFG_TRADE_FEE_BASE_BPS).toBe(rs("WrapperConfigV16", "trade_fee_base_bps"));
    expect(C.WCFG_LP_FEE_ACCRUED_ATOMS).toBe(rs("WrapperConfigV16", "lp_fee_accrued_atoms"));
    expect(C.WCFG_LP_FEE_WITHDRAWN_ATOMS).toBe(rs("WrapperConfigV16", "lp_fee_withdrawn_atoms"));
    expect(C.WCFG_FORCE_CLOSE_DELAY_SLOTS).toBe(rs("WrapperConfigV16", "force_close_delay_slots"));
    expect(OP_NEXT_PORTFOLIO_ID).toBe(rs("AssetOracleProfileV16", "next_portfolio_id"));
    expect(C.ASSET_RISK_LIMITS_OFF).toBe(K.ASSET_RISK_LIMITS_OFF);
    expect(C.ASSET_RISK_LIMITS_LEN).toBe(SIZE.AssetRiskLimitsV17);
    const rl: Array<[number, string]> = [[C.RL_SIDE_OI_CAP_Q, "side_oi_cap_q"], [C.RL_LP_FLOOR_ATOMS, "lp_floor_atoms"], [C.RL_LP_EXPOSURE_K_BPS, "lp_exposure_k_bps"], [C.RL_EXEC_BAND_BPS, "exec_band_bps"], [C.RL_MATCHER_EXT_MODE, "matcher_ext_mode"], [C.RL_RESERVED0, "_reserved0"], [C.RL_MAX_REQUESTED_FEE_BPS, "max_requested_fee_bps"]];
    for (const [v, f] of rl) expect([f, v]).toEqual([f, rs("AssetRiskLimitsV17", f)]);
    expect(C.ASSET_VAULT_LP_OFF).toBe(K.ASSET_VAULT_LP_OFF);
    expect(C.ASSET_VAULT_LP_LEN).toBe(SIZE.AssetVaultLpV18);
    const av: Array<[number, string]> = [[C.AV_VAULT_LP_PORTFOLIO, "vault_lp_portfolio"], [C.AV_LP_NET_Q, "lp_net_q"], [C.AV_LEV_CAP_Q, "lev_cap_q"], [C.AV_LP_NET_SLOT, "lp_net_slot"], [C.AV_SKEW_SLOPE_E9, "skew_slope_e9"], [C.AV_SKEW_MAX_E9, "skew_max_e9"], [C.AV_LEV_MAX_IMR_BPS, "lev_max_imr_bps"], [C.AV_FLAGS, "flags"], [C.AV_RESERVED0, "p2b_flags"], [C.AV_VAULT_LP_MAX_LEV_BPS, "vault_lp_max_lev_bps"], [C.AV_APPROVED_MATCHER_PROGRAM, "approved_matcher_program"]];
    for (const [v, f] of av) expect([f, v]).toEqual([f, rs("AssetVaultLpV18", f)]);
  });
  it("vault-LP state and LP registry constants", () => {
    const vs = C.VS as unknown as Record<string, number>;
    expectTable(vs, "VaultLpStateV18", { base: H });
    expect(C.VAULT_LP_STATE_ACCOUNT_LEN).toBe(H + SIZE.VaultLpStateV18);
    expect(C.LP_VAULT_REGISTRY_ACCOUNT_LEN).toBe(H + SIZE.LpVaultRegistryV16);
    expect(C.REG_TOTAL_LP_SHARES_OUTSTANDING).toBe(H + rs("LpVaultRegistryV16", "total_lp_shares_outstanding"));
    expect(C.REG_VAULT_LP_BOUND_FLAG).toBe(H + rs("LpVaultRegistryV16", "_reserved"));
    expect(C.KIND_VAULT_LP_STATE).toBe(K.KIND_VAULT_LP_STATE);
    expect(C.KIND_LP_VAULT_REGISTRY).toBe(K.KIND_LP_VAULT_REGISTRY);
  });
  it("portfolio constants (fields after the legs move by afterLegsShift)", () => {
    const g = portfolioLegGeometry(v22PortfolioBytes())!;
    expect(g).not.toBeNull();
    const P = (f: string) => H + rs("PortfolioAccountV16Account", f);
    expect(C.PF_OWNER).toBe(P("owner"));
    expect(C.PF_CAPITAL).toBe(P("capital"));
    expect(C.PF_PNL).toBe(P("pnl"));
    expect(C.PF_FEE_CREDITS).toBe(P("fee_credits"));
    expect(C.PF_ACTIVE_BITMAP).toBe(P("active_bitmap"));
    expect(C.PF_LEGS).toBe(P("legs"));
    expect(C.PF_HEALTH_CERT + g.afterLegsShift).toBe(P("health_cert"));
    expect(C.PF_STALE_STATE + g.afterLegsShift).toBe(P("stale_state"));
    expect(C.PF_B_STALE_STATE + g.afterLegsShift).toBe(P("b_stale_state"));
    const cert: Array<[number, string]> = [[C.CERT_EQUITY, "certified_equity"], [C.CERT_ORACLE_EPOCH, "cert_oracle_epoch"], [C.CERT_FUNDING_EPOCH, "cert_funding_epoch"], [C.CERT_RISK_EPOCH, "cert_risk_epoch"], [C.CERT_ASSET_SET_EPOCH, "cert_asset_set_epoch"], [C.CERT_ACTIVE_BITMAP, "active_bitmap_at_cert"], [C.CERT_VALID, "valid"]];
    for (const [v, f] of cert) expect([f, v]).toEqual([f, rs("HealthCertV16Account", f)]);
    // Leg-internal v2.1 constants used by the limits decoders: only the prefix that did not move may be used flag-on.
    expect([C.LEG_ACTIVE, C.LEG_ASSET_INDEX, C.LEG_MARKET_ID, C.LEG_SIDE, C.LEG_BASIS_POS_Q, C.LEG_A_BASIS]).toEqual(
      ["active", "asset_index", "market_id", "side", "basis_pos_q", "a_basis"].map((f) => rs("PortfolioLegV16Account", f)),
    );
  });
});
