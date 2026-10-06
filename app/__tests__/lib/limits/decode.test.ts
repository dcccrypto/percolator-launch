// @vitest-environment node
/**
 * Byte decoders (lib/limits/decode.ts) against:
 *   - LIVE devnet bytes (v18.2): markets from fixtures/v18-liveness (slot 505580400) and the
 *     ANSEM market + one of its portfolios (fixtures/*.json, 2026-09-28);
 *   - Rust-laid-out bytes (fixtures/limits/rust-layouts.json, emitted by
 *     scripts/limits-parity/bin/layouts.rs from the verbatim struct definitions, with
 *     rustc's offset_of! for every field).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import * as C from "@/lib/limits/constants";
import {
  decodeAssetRiskLimits,
  decodeAssetVaultLp,
  decodeMarketEngineView,
  decodePortfolioRisk,
  decodeVaultLpState,
  decodeMatcherCtx,
  signedPositionForAsset,
} from "@/lib/limits/decode";

const FX = join(__dirname, "..", "..", "fixtures");
const liveMarket = (name: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(FX, "v18-liveness", `${name}.b64`), "utf8").trim(), "base64"));
const jsonAccount = (file: string): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(FX, file), "utf8")).dataBase64, "base64"));
const layouts = JSON.parse(readFileSync(join(FX, "limits", "rust-layouts.json"), "utf8")) as {
  offsets: Record<string, number>;
  riskLimitsHex: string;
  assetVaultLpHex: string;
  vaultLpStateHex: string;
};
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("constants agree with rustc's repr(C) layout (offset_of!)", () => {
  it("AssetRiskLimitsV17", () => {
    const o = layouts.offsets;
    expect([o["rl.side_oi_cap_q"], o["rl.lp_floor_atoms"], o["rl.lp_exposure_k_bps"], o["rl.exec_band_bps"], o["rl.matcher_ext_mode"], o["rl._reserved0"], o["rl.max_requested_fee_bps"], o["rl._reserved"]]).toEqual([
      C.RL_SIDE_OI_CAP_Q, C.RL_LP_FLOOR_ATOMS, C.RL_LP_EXPOSURE_K_BPS, C.RL_EXEC_BAND_BPS, C.RL_MATCHER_EXT_MODE, C.RL_RESERVED0, C.RL_MAX_REQUESTED_FEE_BPS, C.RL_RESERVED,
    ]);
  });
  it("AssetVaultLpV18", () => {
    const o = layouts.offsets;
    expect([o["av.lp_net_q"], o["av.lev_cap_q"], o["av.lp_net_slot"], o["av.skew_slope_e9"], o["av.skew_max_e9"], o["av.lev_max_imr_bps"], o["av.flags"], o["av._reserved0"], o["av.vault_lp_max_lev_bps"], o["av.approved_matcher_program"]]).toEqual([
      C.AV_LP_NET_Q, C.AV_LEV_CAP_Q, C.AV_LP_NET_SLOT, C.AV_SKEW_SLOPE_E9, C.AV_SKEW_MAX_E9, C.AV_LEV_MAX_IMR_BPS, C.AV_FLAGS, C.AV_RESERVED0, C.AV_VAULT_LP_MAX_LEV_BPS, C.AV_APPROVED_MATCHER_PROGRAM,
    ]);
  });
  it("VaultLpStateV18 (absolute = HEADER_LEN + struct offset)", () => {
    const o = layouts.offsets;
    expect(C.VS.seniorClaimAtoms).toBe(C.HEADER_LEN + o["vs.senior_claim_atoms"]);
    expect(C.VS.juniorDepositedAtoms).toBe(C.HEADER_LEN + o["vs.junior_deposited_atoms"]);
    expect(C.VS.juniorWithdrawnAtoms).toBe(C.HEADER_LEN + o["vs.junior_withdrawn_atoms"]);
    expect(C.VS.seniorFeeCreditedAtoms).toBe(C.HEADER_LEN + o["vs.senior_fee_credited_atoms"]);
    expect(C.VS.recalledAtoms).toBe(C.HEADER_LEN + o["vs.recalled_atoms"]);
    expect(C.VS.assetIndex).toBe(C.HEADER_LEN + o["vs.asset_index"]);
    expect(C.VS.juniorFloorBps).toBe(C.HEADER_LEN + o["vs.junior_floor_bps"]);
    expect(C.VS.seniorFeeShareBps).toBe(C.HEADER_LEN + o["vs.senior_fee_share_bps"]);
    expect(C.VS.version).toBe(C.HEADER_LEN + o["vs.version"]);
  });
});

describe("live v18.2 market bytes", () => {
  const pengu = liveMarket("pengu-market-v18-healthy");

  it("engine view reads real values (price, margin, OI)", () => {
    const e = decodeMarketEngineView(pengu)!;
    expect(e).not.toBeNull();
    expect(e.effectivePriceE6).toBeGreaterThan(0n);
    expect(e.initialMarginBps).toBeGreaterThan(0n);
    expect(e.initialMarginBps).toBeLessThanOrEqual(10_000n);
    expect(e.maintenanceMarginBps).toBeLessThanOrEqual(e.initialMarginBps);
    expect(e.oiEffLongQ).toBeLessThanOrEqual(C.MAX_OI_SIDE_Q);
    expect(e.mode).toBe(0);
    expect(e.currentSlot).toBeGreaterThan(500_000_000n);
  });

  it("P1 bytes on a v18.2 slab are all zero = protocol defaults (decoded, not refused)", () => {
    for (const name of ["pengu-market-v18-healthy", "collect-market-v18-lapsed", "paid-market-v18-lapsed", "murphy-market-v18-lapsed"]) {
      const r = decodeAssetRiskLimits(liveMarket(name));
      expect(r, name).not.toBeNull();
      expect(r!.allDefault, name).toBe(true);
    }
  });

  it("P3 bytes on a v18.2 slab are all zero = not bound", () => {
    const v = decodeAssetVaultLp(pengu)!;
    expect(v.bound).toBe(false);
    expect(v.lpNetQ).toBe(0n);
  });

  it("refuses a slab whose reserved risk-limit bytes are dirty (the wrapper would too)", () => {
    const d = pengu.slice();
    d[C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF + C.RL_RESERVED + 5] = 1;
    expect(decodeAssetRiskLimits(d)).toBeNull();
  });

  it("too-short buffers decode to null, never throw", () => {
    expect(decodeMarketEngineView(pengu.slice(0, 1000))).toBeNull();
    expect(decodeAssetRiskLimits(pengu.slice(0, 1958))).toBeNull();
    expect(decodeAssetVaultLp(new Uint8Array(10))).toBeNull();
    expect(decodeMatcherCtx(new Uint8Array(100))).toBeNull();
    expect(decodePortfolioRisk(new Uint8Array(100))).toBeNull();
    expect(decodeVaultLpState(new Uint8Array(100))).toBeNull();
  });
});

describe("P1 AssetRiskLimitsV17 from Rust-laid-out bytes", () => {
  it("decodes every field written at offset 608 of asset slot 0", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    d.set(hex(layouts.riskLimitsHex), C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF);
    expect(C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF).toBe(1958);
    const r = decodeAssetRiskLimits(d)!;
    expect(r).toEqual({
      sideOiCapQ: 7_000_000_000n,
      lpFloorAtoms: 250_000_000n,
      lpExposureKBps: 50_000,
      execBandBps: 300,
      matcherExtMode: 1,
      maxRequestedFeeBps: 40,
      allDefault: false,
    });
  });
  it("refuses a fee-channel max above 1023 (validate_asset_risk_limits)", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    new DataView(d.buffer).setUint16(C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF + C.RL_MAX_REQUESTED_FEE_BPS, 1024, true);
    expect(decodeAssetRiskLimits(d)).toBeNull();
  });
  it("refuses a band above the setter max", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    const b = C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF + C.RL_EXEC_BAND_BPS;
    new DataView(d.buffer).setUint16(b, 10_001, true);
    expect(decodeAssetRiskLimits(d)).toBeNull();
  });
});

describe("P3 decoders from Rust-laid-out bytes", () => {
  it("AssetVaultLpV18 at offset 896", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    d.set(hex(layouts.assetVaultLpHex), C.assetWrapperOff(0) + C.ASSET_VAULT_LP_OFF);
    const v = decodeAssetVaultLp(d)!;
    expect(v.bound).toBe(true);
    expect(v.vaultLpPortfolio[0]).toBe(0xab);
    expect(v.vaultLpPortfolio[31]).toBe(0xcd);
    expect(v.lpNetQ).toBe(-12_345_678_901n);
    expect(v.levCapQ).toBe(40_000_000_000n);
    expect(v.lpNetSlot).toBe(505_580_400n);
    expect(v.skewSlopeE9).toBe(2_000n);
    expect(v.skewMaxE9).toBe(900n);
    expect(v.levMaxImrBps).toBe(5_000);
    expect(v.vaultLpMaxLevBps).toBe(20_000);
    expect(v.approvedMatcherProgram.every((b) => b === 0x5a)).toBe(true);
  });
  it("refuses vault_lp_max_lev_bps above 50000 and an undefined p2b_flags bit", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    d.set(hex(layouts.assetVaultLpHex), C.assetWrapperOff(0) + C.ASSET_VAULT_LP_OFF);
    const b = C.assetWrapperOff(0) + C.ASSET_VAULT_LP_OFF;
    const bad = d.slice();
    new DataView(bad.buffer).setUint32(b + C.AV_VAULT_LP_MAX_LEV_BPS, 50_001, true);
    expect(decodeAssetVaultLp(bad)).toBeNull();
    // P2b (#526): the byte is `p2b_flags` now. Bit 0 (creator fees vesting) is valid and decodes;
    // any other bit is still refused (validate_asset_vault_lp).
    const bad2 = d.slice();
    bad2[b + C.AV_RESERVED0] = 2;
    expect(decodeAssetVaultLp(bad2)).toBeNull();
    const vesting = d.slice();
    vesting[b + C.AV_RESERVED0] = 1;
    expect(decodeAssetVaultLp(vesting)?.creatorFeeVesting).toBe(true);
    expect(decodeAssetVaultLp(d)?.creatorFeeVesting).toBeUndefined();
  });
  it("refuses bound flag without a key (validate_asset_vault_lp)", () => {
    const d = liveMarket("pengu-market-v18-healthy").slice();
    d[C.assetWrapperOff(0) + C.ASSET_VAULT_LP_OFF + C.AV_FLAGS] = 1;
    expect(decodeAssetVaultLp(d)).toBeNull();
  });
  it("VaultLpStateV18 account (header + 256 B)", () => {
    const acct = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
    // wrapper `write_header`: magic u64 @0, version u16 @8, kind u8 @10 (literal, not the constant under test)
    acct[10] = 9;
    acct.set(hex(layouts.vaultLpStateHex), 16);
    const s = decodeVaultLpState(acct)!;
    expect(s.seniorClaimAtoms).toBe(1_000_000_000_000n);
    expect(s.juniorDepositedAtoms).toBe(150_000_000_000n);
    expect(s.juniorWithdrawnAtoms).toBe(10_000_000_000n);
    expect(s.seniorFeeCreditedAtoms).toBe(3_210_000_000n);
    expect(s.recalledAtoms).toBe(5n);
    expect(s.juniorFloorBps).toBe(1_000);
    expect(s.seniorFeeShareBps).toBe(10_000);
    expect(s.juniorOwner[0]).toBe(7);
  });
  it("refuses the wrong account kind and a sub-minimum junior floor", () => {
    const acct = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
    acct.set(hex(layouts.vaultLpStateHex), C.HEADER_LEN);
    acct[C.HEADER_KIND_OFF] = 2;
    expect(decodeVaultLpState(acct)).toBeNull();
    acct[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
    new DataView(acct.buffer).setUint16(C.VS.juniorFloorBps, 999, true);
    expect(decodeVaultLpState(acct)).toBeNull();
  });
});

describe("live portfolio (ANSEM's matcher LP, 2SewEcvf) — cross-checked against the SDK parser", () => {
  const pf = jsonAccount("2SewEcvf.portfolio.json");
  const market = jsonAccount("5bVTTMRc.ansem.market.json");

  it("capital / pnl / fee credits agree with parsePortfolioV17", () => {
    const mine = decodePortfolioRisk(pf)!;
    const sdk = parsePortfolioV17(pf);
    expect(mine.capital).toBe(sdk.capital);
    expect(mine.pnl).toBe(sdk.pnl);
    expect(mine.capital).toBe(2_945_082_216n);
  });

  it("signed position uses the leg matching (asset, market_id); a wrong market_id finds none", () => {
    const e = decodeMarketEngineView(market)!;
    const pos = signedPositionForAsset(pf, 0, e.marketId);
    const sdk = parsePortfolioV17(pf);
    const leg = sdk.legs.find((l) => l.active && l.assetIndex === 0);
    if (leg) {
      const mag = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
      expect(pos === mag || pos === -mag).toBe(true);
    } else {
      expect(pos).toBe(0n);
    }
    // Captured 2026-09-28: a live SHORT leg (side 1), basis -16,511,677,058 q.
    expect(pos).toBe(-16_511_677_058n);
    expect(signedPositionForAsset(pf, 0, e.marketId + 999n)).toBe(0n);
    expect(signedPositionForAsset(pf, 1, e.marketId)).toBe(0n);
  });
});

describe("P3 valuation offsets agree with rustc offset_of! (deployed 6377376a; identical on P3 0be66041)", () => {
  const nav = JSON.parse(readFileSync(join(FX, "limits", "rust-nav-offsets.json"), "utf8")) as Record<string, number>;
  it("wrapper cfg, group header, portfolio, health cert", () => {
    expect(C.WCFG_LP_FEE_ACCRUED_ATOMS).toBe(nav["wcfg.lp_fee_accrued_atoms"]);
    expect(C.WCFG_LP_FEE_WITHDRAWN_ATOMS).toBe(nav["wcfg.lp_fee_withdrawn_atoms"]);
    expect(C.H_VAULT).toBe(nav["hdr.vault"]);
    expect(C.H_INSURANCE).toBe(nav["hdr.insurance"]);
    expect(C.H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL).toBe(nav["hdr.source_insurance_credit_reserved_total_atoms"]);
    expect(C.H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL).toBe(nav["hdr.insurance_domain_budget_remaining_total"]);
    expect([C.H_RISK_EPOCH, C.H_ASSET_SET_EPOCH, C.H_ORACLE_EPOCH, C.H_FUNDING_EPOCH]).toEqual([
      nav["hdr.risk_epoch"], nav["hdr.asset_set_epoch"], nav["hdr.oracle_epoch"], nav["hdr.funding_epoch"],
    ]);
    expect(C.PF_ACTIVE_BITMAP).toBe(C.HEADER_LEN + nav["pf.active_bitmap"]);
    expect(C.PF_HEALTH_CERT).toBe(C.HEADER_LEN + nav["pf.health_cert"]);
    expect(C.PF_STALE_STATE).toBe(C.HEADER_LEN + nav["pf.stale_state"]);
    expect(C.PF_B_STALE_STATE).toBe(C.HEADER_LEN + nav["pf.b_stale_state"]);
    expect([C.CERT_EQUITY, C.CERT_ORACLE_EPOCH, C.CERT_FUNDING_EPOCH, C.CERT_RISK_EPOCH, C.CERT_ASSET_SET_EPOCH, C.CERT_ACTIVE_BITMAP, C.CERT_VALID]).toEqual([
      nav["cert.certified_equity"], nav["cert.cert_oracle_epoch"], nav["cert.cert_funding_epoch"], nav["cert.cert_risk_epoch"],
      nav["cert.cert_asset_set_epoch"], nav["cert.active_bitmap_at_cert"], nav["cert.valid"],
    ]);
    expect(nav["bitmap.size"]).toBe(8);
  });

  it("live ANSEM LP portfolio: active bitmap marks its one leg; cert bool byte is 0/1; epochs are plausible vs the market", () => {
    const pf = jsonAccount("2SewEcvf.portfolio.json");
    const market = jsonAccount("5bVTTMRc.ansem.market.json");
    const r = decodePortfolioRisk(pf)!;
    const e = decodeMarketEngineView(market)!;
    expect(r.activeBitmap & 1n).toBe(1n); // leg slot 0 is active (the -16.5B short)
    expect([0, 1]).toContain(r.cert.validByte);
    expect([0, 1]).toContain(r.staleState);
    expect(r.cert.riskEpoch <= e.riskEpoch).toBe(true);
    expect(r.cert.oracleEpoch <= e.oracleEpoch).toBe(true);
    // v18.2 slab: the fee-leg claim is consistent (withdrawn <= accrued)
    expect(e.lpFeeWithdrawnAtoms <= e.lpFeeAccruedAtoms).toBe(true);
    expect(e.maxTradingFeeBps).toBeGreaterThan(0n);
  });
});
