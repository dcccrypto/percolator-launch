// @vitest-environment node
/**
 * Extra coverage for lib/limits/decode.ts: matcher ctx (+v2 block), LP-vault registry readers,
 * resolved market / portfolio, terminal backing, portfolio legs, and the refusal paths
 * (truncation, wrong kind, unknown version). Bytes are built field by field, then each decoded field is pinned.
 * Flag off (default): v2.1 geometry, the geometry the live fixtures use.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "@/lib/limits/constants";
import {
  u128,
  i128,
  marketLimitsSliceLen,
  isV18MarketHeader,
  decodeMarketEngineView,
  decodeAssetRiskLimits,
  decodeAssetVaultLp,
  decodePortfolioRisk,
  decodePortfolioLegs,
  signedPositionForAsset,
  decodeMatcherCtx,
  decodeVaultLpState,
  decodeLpVaultRegistryShares,
  decodeLpVaultRegistryBound,
  decodeLpVaultRegistryOiThresholdBps,
  decodeLpVaultRegistryDomain,
  decodeResolvedMarket,
  decodeResolvedPortfolio,
  decodeTerminalBacking,
  decodeTerminalBackingDomains,
} from "@/lib/limits/decode";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const FX = join(__dirname, "..", "..", "fixtures");
const liveMarket = (): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(FX, "v18-liveness", "pengu-market-v18-healthy.b64"), "utf8").trim(), "base64"));
const livePortfolio = (): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(FX, "2SewEcvf.portfolio.json"), "utf8")).dataBase64, "base64"));

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const put128 = (d: Uint8Array, off: number, v: bigint) => {
  view(d).setBigUint64(off, v & ((1n << 64n) - 1n), true);
  view(d).setBigUint64(off + 8, v >> 64n, true);
};

afterEach(() => __setDevnetV22ForTest(null));

describe("u128 / i128", () => {
  it("round-trip across the 64-bit boundary and sign", () => {
    const d = new Uint8Array(16);
    put128(d, 0, (1n << 64n) + 5n);
    expect(u128(d, 0)).toBe((1n << 64n) + 5n);
    d.fill(0xff);
    expect(u128(d, 0)).toBe((1n << 128n) - 1n);
    expect(i128(d, 0)).toBe(-1n);
    put128(d, 0, 1n << 127n);
    expect(i128(d, 0)).toBe(-(1n << 127n));
  });
  it("honours a subarray's byteOffset", () => {
    const big = new Uint8Array(40);
    put128(big, 8, 77n);
    expect(u128(big.subarray(8), 0)).toBe(77n);
  });
});

describe("matcher ctx", () => {
  const len = C.MC_V2_BLOCK + C.V2_BLOCK_LEN;
  const build = (v2Version: number) => {
    const d = new Uint8Array(len);
    const v = view(d);
    d[C.MC_KIND] = 2;
    v.setUint32(C.MC_TRADING_FEE_BPS, 11, true);
    v.setUint32(C.MC_BASE_SPREAD_BPS, 22, true);
    v.setUint32(C.MC_MAX_TOTAL_BPS, 33, true);
    v.setUint32(C.MC_IMPACT_K_BPS, 44, true);
    put128(d, C.MC_LIQUIDITY_NOTIONAL_E6, 5_000_000_000_000n);
    put128(d, C.MC_MAX_FILL_ABS, 6_000n);
    put128(d, C.MC_INVENTORY_BASE, (1n << 128n) - 7n); // i128 -7
    put128(d, C.MC_MAX_INVENTORY_ABS, 8_000n);
    v.setUint16(C.MC_FEE_TO_INSURANCE_BPS, 55, true);
    v.setUint16(C.MC_SKEW_SPREAD_MULT_BPS, 66, true);
    const b = C.MC_V2_BLOCK;
    d[b + C.V2.version] = v2Version;
    d[b + C.V2.flags] = 3;
    v.setUint16(b + C.V2.feeLoBps, 101, true);
    v.setUint16(b + C.V2.feeHiBps, 102, true);
    v.setUint16(b + C.V2.feeColdBps, 103, true);
    v.setUint16(b + C.V2.volAMilli, 104, true);
    v.setUint16(b + C.V2.volBDen, 105, true);
    v.setUint16(b + C.V2.volAlphaBps, 106, true);
    d[b + C.V2.volWarmupLeft] = 7;
    d[b + C.V2.volMoveCap10bps] = 9;
    v.setUint16(b + C.V2.volRefSlots, 107, true);
    v.setUint16(b + C.V2.thinRebateMultBps, 108, true);
    v.setUint16(b + C.V2.skewCapBps, 109, true);
    v.setUint16(b + C.V2.rebateCapBps, 110, true);
    v.setUint16(b + C.V2.maxMarkAgeSlots, 111, true);
    v.setUint16(b + C.V2.observedStaleSlots, 112, true);
    v.setUint16(b + C.V2.boundAssetPlus1, 113, true);
    v.setBigUint64(b + C.V2.skewRefInventory, 201n, true);
    v.setBigUint64(b + C.V2.volVarE4, 202n, true);
    v.setBigUint64(b + C.V2.volLastPriceE6, 203n, true);
    v.setBigUint64(b + C.V2.volLastSlot, 204n, true);
    return d;
  };

  it("decodes the v1 header and the v2 block field by field", () => {
    expect(decodeMatcherCtx(build(C.V2_BLOCK_VERSION))).toEqual({
      kind: 2,
      tradingFeeBps: 11,
      baseSpreadBps: 22,
      maxTotalBps: 33,
      impactKBps: 44,
      liquidityNotionalE6: 5_000_000_000_000n,
      maxFillAbs: 6_000n,
      inventoryBase: -7n,
      maxInventoryAbs: 8_000n,
      feeToInsuranceBps: 55,
      skewSpreadMultBps: 66,
      v2: {
        flags: 3, feeLoBps: 101, feeHiBps: 102, feeColdBps: 103, volAMilli: 104, volBDen: 105, volAlphaBps: 106,
        volWarmupLeft: 7, volMoveCap10bps: 9, volRefSlots: 107, thinRebateMultBps: 108, skewCapBps: 109,
        rebateCapBps: 110, maxMarkAgeSlots: 111, observedStaleSlots: 112, boundAssetPlus1: 113,
        skewRefInventory: 201n, volVarE4: 202n, volLastPriceE6: 203n, volLastSlot: 204n,
      },
    });
  });
  it("marker byte 0 or an unknown block version => v2 null, rest still decoded", () => {
    for (const ver of [0, C.V2_BLOCK_VERSION + 1, 255]) {
      const r = decodeMatcherCtx(build(ver))!;
      expect(r.v2).toBeNull();
      expect(r.tradingFeeBps).toBe(11);
    }
  });
  it("refuses one byte short of the v2 block end", () => {
    expect(decodeMatcherCtx(build(1).slice(0, len - 1))).toBeNull();
    expect(decodeMatcherCtx(new Uint8Array(0))).toBeNull();
  });
});

describe("LP vault registry readers", () => {
  const reg = () => {
    const d = new Uint8Array(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
    d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
    return d;
  };
  it("decodes shares, bound flag, oi threshold and domain", () => {
    const d = reg();
    put128(d, C.REG_TOTAL_LP_SHARES_OUTSTANDING, (1n << 70n) + 3n);
    view(d).setUint16(C.HEADER_LEN + 130, 2_500, true);
    view(d).setUint16(C.REG_DOMAIN, 3, true);
    expect(decodeLpVaultRegistryShares(d)).toBe((1n << 70n) + 3n);
    expect(decodeLpVaultRegistryOiThresholdBps(d)).toBe(2_500);
    expect(decodeLpVaultRegistryDomain(d)).toBe(3);
    expect(decodeLpVaultRegistryBound(d)).toBe(false);
    d[C.REG_VAULT_LP_BOUND_FLAG] = 1;
    expect(decodeLpVaultRegistryBound(d)).toBe(true);
    d[C.REG_VAULT_LP_BOUND_FLAG] = 2;
    expect(decodeLpVaultRegistryBound(d)).toBe("invalid");
  });
  it("short buffer and wrong kind => null from every reader", () => {
    const short = reg().slice(0, C.LP_VAULT_REGISTRY_ACCOUNT_LEN - 1);
    const wrong = reg();
    wrong[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
    for (const d of [short, wrong]) {
      expect(decodeLpVaultRegistryShares(d)).toBeNull();
      expect(decodeLpVaultRegistryBound(d)).toBeNull();
      expect(decodeLpVaultRegistryOiThresholdBps(d)).toBeNull();
      expect(decodeLpVaultRegistryDomain(d)).toBeNull();
    }
  });
});

describe("vault LP state refusals and the senior-draw fields", () => {
  const acct = () => {
    const d = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
    d[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
    d[C.VS.version] = C.VAULT_LP_STATE_VERSION;
    view(d).setUint16(C.VS.juniorFloorBps, C.VAULT_LP_MIN_JUNIOR_FLOOR_BPS, true);
    return d;
  };
  it("pins senior draw fields, asset index and the 32-byte keys", () => {
    const d = acct();
    put128(d, C.VS.seniorDrawnAtoms, 123n);
    put128(d, C.VS.seniorDrawOutstandingAtoms, 45n);
    view(d).setUint16(C.VS.assetIndex, 4, true);
    d.fill(0x11, C.VS.lpPortfolio, C.VS.lpPortfolio + 32);
    const s = decodeVaultLpState(d)!;
    expect(s.seniorDrawnAtoms).toBe(123n);
    expect(s.seniorDrawOutstandingAtoms).toBe(45n);
    expect(s.assetIndex).toBe(4);
    expect(s.lpPortfolio).toEqual(new Uint8Array(32).fill(0x11));
  });
  it("refuses unknown version, floor above max, and truncation", () => {
    const bad = acct();
    bad[C.VS.version] = C.VAULT_LP_STATE_VERSION + 1;
    expect(decodeVaultLpState(bad)).toBeNull();
    const hi = acct();
    view(hi).setUint16(C.VS.juniorFloorBps, C.VAULT_LP_MAX_JUNIOR_FLOOR_BPS + 1, true);
    expect(decodeVaultLpState(hi)).toBeNull();
    expect(decodeVaultLpState(acct().slice(0, C.VAULT_LP_STATE_ACCOUNT_LEN - 1))).toBeNull();
    expect(decodeVaultLpState(acct())).not.toBeNull();
  });
});

describe("market views: truncation, header and extra fields", () => {
  it("marketLimitsSliceLen follows the flag", () => {
    expect(marketLimitsSliceLen(0)).toBe(C.assetEngineOff(0) + 1301);
    expect(marketLimitsSliceLen(2)).toBe(C.assetEngineOff(2) + 1301);
    __setDevnetV22ForTest(true);
    expect(marketLimitsSliceLen(0)).toBeGreaterThan(C.assetEngineOff(0) + 1301);
  });
  it("isV18MarketHeader: live slab true; short, bad magic, bad version, bad kind false", () => {
    const m = liveMarket();
    expect(isV18MarketHeader(m)).toBe(true);
    expect(isV18MarketHeader(m.slice(0, C.HEADER_LEN - 1))).toBe(false);
    const magic = m.slice(); magic[0] ^= 0xff;
    expect(isV18MarketHeader(magic)).toBe(false);
    const ver = m.slice(); ver[8] = 17;
    expect(isV18MarketHeader(ver)).toBe(false);
    const kind = m.slice(); kind[C.HEADER_KIND_OFF] = C.KIND_PORTFOLIO;
    expect(isV18MarketHeader(kind)).toBe(false);
  });
  it("engine view refuses a non-v18 header even when long enough", () => {
    const ver = liveMarket(); ver[8] = 17;
    expect(decodeMarketEngineView(ver)).toBeNull();
  });
  it("engine view reads the money/epoch fields written at their offsets", () => {
    const m = liveMarket().slice();
    const M = marketOffsets(m, "t");
    put128(m, M.hdr(C.H_VAULT), 1_000n);
    put128(m, M.hdr(C.H_INSURANCE), 200n);
    view(m).setBigUint64(M.hdr(C.H_RISK_EPOCH), 31n, true);
    view(m).setBigUint64(M.hdr(C.H_FUNDING_EPOCH), 32n, true);
    const e = decodeMarketEngineView(m)!;
    expect(e.vaultAtoms).toBe(1_000n);
    expect(e.insuranceAtoms).toBe(200n);
    expect(e.riskEpoch).toBe(31n);
    expect(e.fundingEpoch).toBe(32n);
  });
  it("risk limits: v2.1 allDefault, bad matcher mode / lp exposure refused, undersized refused", () => {
    const base = liveMarket().slice();
    const b = C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF;
    const nz = base.slice(); nz[b + C.RL_RESERVED0] = 1;
    expect(decodeAssetRiskLimits(nz)).toBeNull();
    const mode = base.slice(); mode[b + C.RL_MATCHER_EXT_MODE] = C.MATCHER_EXT_MODE_V1 + 1;
    expect(decodeAssetRiskLimits(mode)).toBeNull();
    const k = base.slice(); view(k).setUint32(b + C.RL_LP_EXPOSURE_K_BPS, C.MAX_LP_EXPOSURE_K_BPS + 1, true);
    expect(decodeAssetRiskLimits(k)).toBeNull();
    expect(decodeAssetRiskLimits(base.slice(0, b + C.ASSET_RISK_LIMITS_LEN - 1))).toBeNull();
  });
  it("vault LP: levMaxImr above 10000 and non-zero key without bound flag refused; short refused", () => {
    const base = liveMarket().slice();
    const b = C.assetWrapperOff(0) + C.ASSET_VAULT_LP_OFF;
    const imr = base.slice(); view(imr).setUint16(b + C.AV_LEV_MAX_IMR_BPS, 10_001, true);
    expect(decodeAssetVaultLp(imr)).toBeNull();
    const key = base.slice(); key[b + C.AV_VAULT_LP_PORTFOLIO] = 1;
    expect(decodeAssetVaultLp(key)).toBeNull();
    const flag = base.slice(); flag[b + C.AV_FLAGS] = 2;
    expect(decodeAssetVaultLp(flag)).toBeNull();
    expect(decodeAssetVaultLp(base.slice(0, b + C.ASSET_VAULT_LP_LEN - 1))).toBeNull();
  });
});

describe("v2.2 flag on: ADL wind-down lane and unknown versions", () => {
  const b = () => C.assetWrapperOff(0) + C.ASSET_RISK_LIMITS_OFF;
  it("bytes [42,64) are not reserved: nonzero Earn floor / ADL slots decode, allDefault ignores them", () => {
    __setDevnetV22ForTest(true);
    const d = liveMarket().slice();
    view(d).setUint16(b() + 42, 700, true); // senior floor code
    view(d).setUint32(b() + 44, 9_000, true); // at the maximum
    const r = decodeAssetRiskLimits(d)!;
    expect(r).not.toBeNull();
    expect(r.allDefault).toBe(true);
    // the same bytes are refused with the flag off (v2.1 requires them zero)
    __setDevnetV22ForTest(false);
    expect(decodeAssetRiskLimits(d)).toBeNull();
  });
  it("refuses an ADL episode length above 9000", () => {
    __setDevnetV22ForTest(true);
    const d = liveMarket().slice();
    view(d).setUint32(b() + 44, 9_001, true);
    expect(decodeAssetRiskLimits(d)).toBeNull();
  });
  it("an unknown market VERSION is refused by every market decoder", () => {
    __setDevnetV22ForTest(true);
    const d = liveMarket().slice();
    d[8] = 99;
    expect(decodeAssetRiskLimits(d)).toBeNull();
    expect(decodeAssetVaultLp(d)).toBeNull();
    expect(decodeMarketEngineView(d)).toBeNull();
    expect(decodeResolvedMarket(d)).toBeNull();
    expect(decodeTerminalBacking(d, 0)).toBeNull();
    expect(isV18MarketHeader(d)).toBe(false);
  });
  it("a known v2.1 slab still passes the header check under the flag", () => {
    __setDevnetV22ForTest(true);
    expect(isV18MarketHeader(liveMarket())).toBe(true);
  });
});

describe("resolved market and terminal backing", () => {
  const market = () => {
    const m = liveMarket().slice();
    const M = marketOffsets(m, "t");
    return { m, M };
  };
  it("decodeResolvedMarket pins each field", () => {
    const { m, M } = market();
    m[M.hdr(C.H_MODE)] = C.MARKET_MODE_RESOLVED;
    view(m).setBigUint64(M.hdr(C.H_CURRENT_SLOT), 900n, true);
    view(m).setBigUint64(M.hdr(C.H_RESOLVED_SLOT), 800n, true);
    view(m).setBigUint64(C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS, 150n, true);
    put128(m, M.hdr(C.H_C_TOT), 42n);
    view(m).setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), 3n, true);
    const r = decodeResolvedMarket(m)!;
    expect(r.mode).toBe(1);
    expect(r.currentSlot).toBe(900n);
    expect(r.resolvedSlot).toBe(800n);
    expect(r.forceCloseDelaySlots).toBe(150n);
    expect(r.cTot).toBe(42n);
    expect(r.materializedPortfolioCount).toBe(3n);
    expect(r.marketauth).toEqual(m.slice(C.HEADER_LEN, C.HEADER_LEN + 32));
  });
  it("decodeResolvedMarket refuses truncated, non-v18 and unknown-version input", () => {
    const { m, M } = market();
    expect(decodeResolvedMarket(m.slice(0, M.g + M.layout.marketGroupLen - 1))).toBeNull();
    const ver = m.slice(); ver[8] = 17;
    expect(decodeResolvedMarket(ver)).toBeNull();
    expect(decodeResolvedMarket(new Uint8Array(8))).toBeNull();
  });
  it("terminal backing: residual = vault - owned (saturating), physical per domain", () => {
    const { m, M } = market();
    const S = C.BOUND_SCALE;
    put128(m, M.hdr(C.H_VAULT), 10_000n);
    put128(m, M.hdr(C.H_C_TOT), 3_000n);
    put128(m, M.hdr(C.H_INSURANCE), 1_000n);
    put128(m, M.hdr(C.H_BACKING_PROVIDER_EARNINGS_TOTAL), 500n);
    put128(m, M.hdr(C.H_SOURCE_FRESH_BACKING_TOTAL_NUM), 2n * S + 5n); // floor(.. / S) = 2
    const dom = (n: number) => M.engineOff(Math.floor(n / 2)) + M.slotRel(n % 2 === 0 ? C.SLOT_BACKING_LONG : C.SLOT_BACKING_SHORT) + C.BUCKET_FRESH_UNLIENED_BACKING_NUM;
    put128(m, dom(2), 7n * S + 1n); // long bucket of asset 1
    put128(m, dom(3), 4n * S); // short bucket of asset 1
    const t = decodeTerminalBacking(m, 2)!;
    expect(t.residual).toBe(10_000n - (3_000n + 1_000n + 500n + 2n));
    expect(t.physical).toBe(11n);
    expect(decodeTerminalBackingDomains(m, 2)).toEqual([7n, 4n]);
    // registry domain 3: order flips (own, then sibling = 3 ^ 1 = 2)
    expect(decodeTerminalBackingDomains(m, 3)).toEqual([4n, 7n]);
    // owned above vault => residual saturates at 0
    put128(m, M.hdr(C.H_VAULT), 1n);
    expect(decodeTerminalBacking(m, 2)!.residual).toBe(0n);
  });
  it("terminal backing refuses short, non-v18, and a domain whose bucket lies past the end", () => {
    const { m, M } = market();
    for (const fn of [decodeTerminalBacking, decodeTerminalBackingDomains]) {
      expect(fn(m.slice(0, M.g + M.layout.marketGroupLen - 1), 0)).toBeNull();
      const ver = m.slice(); ver[8] = 17;
      expect(fn(ver, 0)).toBeNull();
      expect(fn(new Uint8Array(4), 0)).toBeNull();
    }
    // A huge domain index points past the account.
    expect(decodeTerminalBacking(m, 2_000)).toBeNull();
    expect(decodeTerminalBackingDomains(m, 2_000)).toBeNull();
  });
});

describe("portfolio: legs, resolved view, refusals", () => {
  it("decodePortfolioLegs lists only active legs with raw basis; signedPositionForAsset matches", () => {
    const pf = livePortfolio().slice();
    const legs = decodePortfolioLegs(pf);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs[0]).toMatchObject({ slot: 0, assetIndex: 0, side: 1, basisPosQ: -16_511_677_058n });
    // Deactivate slot 0 => it disappears and the signed position is 0.
    pf[C.PF_LEGS + C.LEG_ACTIVE] = 0;
    expect(decodePortfolioLegs(pf).some((l) => l.slot === 0)).toBe(false);
    // Activate slot 5 as a Long of +9 on asset 3 / market 77.
    const l = C.PF_LEGS + 5 * C.PF_LEG_LEN;
    pf[l + C.LEG_ACTIVE] = 1;
    view(pf).setUint32(l + C.LEG_ASSET_INDEX, 3, true);
    view(pf).setBigUint64(l + C.LEG_MARKET_ID, 77n, true);
    pf[l + C.LEG_SIDE] = 0;
    put128(pf, l + C.LEG_BASIS_POS_Q, 9n);
    expect(decodePortfolioLegs(pf).find((x) => x.slot === 5)).toEqual({ slot: 5, assetIndex: 3, side: 0, basisPosQ: 9n });
    expect(signedPositionForAsset(pf, 3, 77n)).toBe(9n);
    pf[l + C.LEG_SIDE] = 1;
    put128(pf, l + C.LEG_BASIS_POS_Q, (1n << 128n) - 9n); // -9
    expect(signedPositionForAsset(pf, 3, 77n)).toBe(-9n); // short => -|basis|
    pf[l + C.LEG_SIDE] = 0;
    expect(signedPositionForAsset(pf, 3, 77n)).toBe(9n); // long => +|basis| even from negative basis
  });
  it("legs / signed position return empty on truncated input", () => {
    const pf = livePortfolio();
    expect(decodePortfolioLegs(pf.slice(0, C.PF_LEGS + 10))).toEqual([]);
    expect(signedPositionForAsset(pf.slice(0, C.PF_LEGS + 10), 0, 1n)).toBe(0n);
  });
  it("decodePortfolioRisk pins header fields and the health cert; refuses a truncated tail", () => {
    const pf = livePortfolio().slice();
    put128(pf, C.PF_FEE_CREDITS, (1n << 128n) - 3n);
    pf[C.PF_STALE_STATE] = 1;
    pf[C.PF_B_STALE_STATE] = 2;
    put128(pf, C.PF_HEALTH_CERT + C.CERT_EQUITY, 555n);
    view(pf).setBigUint64(C.PF_HEALTH_CERT + C.CERT_ORACLE_EPOCH, 11n, true);
    view(pf).setBigUint64(C.PF_HEALTH_CERT + C.CERT_FUNDING_EPOCH, 12n, true);
    view(pf).setBigUint64(C.PF_HEALTH_CERT + C.CERT_RISK_EPOCH, 13n, true);
    view(pf).setBigUint64(C.PF_HEALTH_CERT + C.CERT_ASSET_SET_EPOCH, 14n, true);
    view(pf).setBigUint64(C.PF_HEALTH_CERT + C.CERT_ACTIVE_BITMAP, 15n, true);
    pf[C.PF_HEALTH_CERT + C.CERT_VALID] = 1;
    const r = decodePortfolioRisk(pf)!;
    expect(r.feeCredits).toBe(-3n);
    expect(r.staleState).toBe(1);
    expect(r.bStaleState).toBe(2);
    expect(r.owner).toEqual(pf.slice(C.PF_OWNER, C.PF_OWNER + 32));
    expect(r.cert).toEqual({ certifiedEquity: 555n, oracleEpoch: 11n, fundingEpoch: 12n, riskEpoch: 13n, assetSetEpoch: 14n, activeBitmapAtCert: 15n, validByte: 1 });
    expect(decodePortfolioRisk(pf.slice(0, C.PF_B_STALE_STATE))).toBeNull();
  });
  it("decodeResolvedPortfolio pins every flag and amount", () => {
    const pf = livePortfolio().slice();
    put128(pf, C.PF_RESERVED_PNL, 21n);
    put128(pf, C.PF_CANCEL_DEPOSIT_ESCROW, 22n);
    pf[C.PF_STALE_STATE] = 1;
    pf[C.PF_B_STALE_STATE] = 0;
    pf[C.PF_REBALANCE_LOCK] = 1;
    pf[C.PF_LIQUIDATION_LOCK] = 0;
    pf[C.PF_RESOLVED_PAYOUT_RECEIPT + C.RECEIPT_PRESENT] = 1;
    pf[C.PF_RESOLVED_PAYOUT_RECEIPT + C.RECEIPT_FINALIZED] = 0;
    const r = decodeResolvedPortfolio(pf)!;
    expect(r).toMatchObject({
      reservedPnl: 21n, cancelDepositEscrow: 22n, stale: true, bStale: false,
      rebalanceLock: true, liquidationLock: false, receiptPresent: true, receiptFinalized: false,
    });
    expect(r.capital).toBe(2_945_082_216n);
    expect(r.owner).toEqual(pf.slice(C.PF_OWNER, C.PF_OWNER + 32));
    pf[C.PF_RESOLVED_PAYOUT_RECEIPT + C.RECEIPT_FINALIZED] = 5;
    pf[C.PF_LIQUIDATION_LOCK] = 9;
    expect(decodeResolvedPortfolio(pf)).toMatchObject({ receiptFinalized: true, liquidationLock: true });
  });
  it("decodeResolvedPortfolio refuses wrong kind and truncation", () => {
    const pf = livePortfolio();
    const kind = pf.slice(); kind[C.HEADER_KIND_OFF] = C.KIND_MARKET_ACCOUNT;
    expect(decodeResolvedPortfolio(kind)).toBeNull();
    expect(decodeResolvedPortfolio(pf.slice(0, C.PF_RESOLVED_PAYOUT_RECEIPT + C.RECEIPT_FINALIZED))).toBeNull();
    expect(decodeResolvedPortfolio(new Uint8Array(10))).toBeNull();
  });
});
