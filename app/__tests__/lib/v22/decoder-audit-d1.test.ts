// @vitest-environment node
/**
 * v2.2 QA D-1 (decoder audit, 2026-10-12). Three bugs of one class in a row (NB-1 portfolio parser, K-2 offsets,
 * RT5-1 risk-limit record): an in-app decoder with a stale offset or a stale "must be zero" check on v2.2.
 *
 * Differential: the REAL devnet bytes of the 9 preview markets + the 5-slot multi-asset market, their vault-LP state,
 * LP registry, LP portfolio, matcher context, two positioned user portfolios and every v5 stake pool
 * (fixtures/v22-decoder-audit-d1-2026-10-12.json, captured read-only) are decoded by the app decoder AND the SDK
 * v2.2 decoder (the verbatim port in lib/v22/sdk, = percolator-sdk feat/v22-sdk), and every shared field must agree.
 * Where the SDK has no parser the app offset is checked against the SDK's LAYOUT_V22 table and the value against a
 * second, independent decoder. Plus the three fixes the audit produced, each with its negative control.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { encodeInitMarket } from "@percolatorct/sdk";
import fx from "../../fixtures/v22-decoder-audit-d1-2026-10-12.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import * as D from "@/lib/limits/decode";
import * as C from "@/lib/limits/constants";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { parsePortfolio, portfolioLegGeometry } from "@/lib/v22/layout";
import { decodeGrowthRecord } from "@/lib/v21/growth-market";
import { readTradeFeeInputsApp, utilFeeMaxBpsOf } from "@/lib/limits/trade-fee-resolve";
import { v22Slab, decodeStakePoolV5, resolveLayout, resolvePortfolioLayout, ACCOUNT_KIND, STAKE_POOL_SIZE_V5, encodeInitMarketTrailerV22 } from "@/lib/v22/sdk";
import { decodeAssetRiskLimitsP1 } from "@/lib/v22/sdk/records/risk-limits-p1";
import { decodeAssetVaultLpP3, decodeVaultLpStateP3 } from "@/lib/v22/sdk/records/p3-vault-lp";
import { decodeAssetGrowthV19, utilFeeMaxEffectiveBps } from "@/lib/v22/sdk/records/growth-v19";
import { decodeAdlEpisode } from "@/lib/v22/sdk/records/p2b-lock-exits";
import { readV17AssetSlotLast } from "@/lib/v17-engine-clock";
import { planCatchUp } from "@/lib/self-heal";
import { decodePreResolvePool } from "@/lib/pre-resolve";
import { decodeInitMarketData } from "@/lib/launch-recovery";
import { buildV17InitMarketArgs } from "@/lib/create-market-args";
import { deriveLaunchMarketParams } from "@/lib/market-params";
import { liftV22Portfolio } from "../../helpers/portfolio-disc20";

type Mkt = { market: string; marketB64: string; vaultLpStateB64: string | null; registryB64: string | null; lpPortfolio: string | null; lpPortfolioB64: string | null; matcherCtxB64: string | null };
const MARKETS = fx.markets as unknown as Record<string, Mkt>;
const PORTFOLIOS = fx.portfolios as unknown as Record<string, { address: string; dataB64: string }>;
const POOLS = fx.stakePools as unknown as Record<string, string>;
const b = (s: string) => liftV22Portfolio(new Uint8Array(Buffer.from(s, "base64"))); // recorded pre-#299 portfolios lifted to disc 20
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => (u64(d, o + 8) << 64n) | u64(d, o);
const pk = (u: Uint8Array) => new PublicKey(u).toBase58();
const slotsOf = (d: Uint8Array) => dv(d).getUint16(resolveLayout(d, { parser: "t", kind: ACCOUNT_KIND.Market }).marketGroupOff + 32 + 2, true);

beforeEach(() => { __setDevnetV22ForTest(true); __setDevnetV21ForTest(true); });
afterEach(() => { __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); });

describe("D-1: the fixture is what it says", () => {
  it("10 markets (VERSION 19), 9 LP portfolios + matcher contexts, 2 user portfolios, v5 stake pools", () => {
    expect(Object.keys(MARKETS)).toHaveLength(10);
    for (const m of Object.values(MARKETS)) expect(dv(b(m.marketB64)).getUint16(8, true)).toBe(19);
    expect(Object.values(MARKETS).filter((m) => m.lpPortfolioB64 && m.matcherCtxB64)).toHaveLength(9);
    expect(Object.keys(PORTFOLIOS)).toHaveLength(2);
    expect(Object.keys(POOLS).length).toBeGreaterThanOrEqual(9);
    expect(slotsOf(b(MARKETS.MULTI5.marketB64))).toBe(5);
  });
});

describe("D-1: market header + asset slot (decodeMarketEngineView)", () => {
  for (const [name, m] of Object.entries(MARKETS)) {
    it(`${name}: every field agrees with the SDK parsers / the LAYOUT_V22 table, for every asset slot`, () => {
      const d = b(m.marketB64);
      const L = resolveLayout(d, { parser: "t", kind: ACCOUNT_KIND.Market });
      const g = L.marketGroupOff;
      const wcfg = v22Slab.parseWrapperConfigV17(d);
      const oi = v22Slab.parseMarketGroupV17OI(d);
      const M = marketOffsets(d, "t");
      // The app's shifted header offsets are the SDK table's.
      expect(M.hdr(C.H_CURRENT_SLOT)).toBe(g + L.group.currentSlot);
      expect(M.hdr(C.H_MODE)).toBe(g + L.group.mode);
      expect(M.hdr(C.H_VAULT)).toBe(g + L.group.vault);
      expect(M.hdr(C.H_INSURANCE)).toBe(g + L.group.insurance);
      expect(M.hdr(C.H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL)).toBe(g + L.group.sourceInsuranceCreditReservedTotalAtoms);
      expect(M.hdr(C.H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL)).toBe(g + L.group.insuranceDomainBudgetRemainingTotal);
      for (let i = 0; i < slotsOf(d); i++) {
        const e = D.decodeMarketEngineView(d, i)!;
        expect(e, `asset ${i}`).not.toBeNull();
        const eng = g + L.marketGroupLen + i * L.assetSlotStride + L.wrapperSlotLen;
        expect(M.engineOff(i)).toBe(eng);
        expect(e.currentSlot).toBe(u64(d, g + L.group.currentSlot));
        expect(e.mode).toBe(d[g + L.group.mode]);
        expect(e.vaultAtoms).toBe(u128(d, g + L.group.vault));
        expect(e.insuranceAtoms).toBe(u128(d, g + L.group.insurance));
        expect(e.insuranceAtoms).toBe(oi.insuranceBalance);
        expect(e.sourceInsuranceCreditReservedTotal).toBe(u128(d, g + L.group.sourceInsuranceCreditReservedTotalAtoms));
        expect(e.insuranceDomainBudgetRemainingTotal).toBe(u128(d, g + L.group.insuranceDomainBudgetRemainingTotal));
        expect(e.effectivePriceE6).toBe(u64(d, eng + L.assetState.effectivePrice));
        expect(e.targetPriceE6).toBe(u64(d, eng + L.assetState.rawOracleTargetPrice));
        expect(e.oiEffLongQ).toBe(u128(d, eng + L.assetState.oiEffLongQ));
        expect(e.oiEffShortQ).toBe(u128(d, eng + L.assetState.oiEffShortQ));
        const a = oi.assets.find((x) => x.assetIndex === i);
        if (a) expect([e.oiEffLongQ, e.oiEffShortQ]).toEqual([a.oiEffLongQ, a.oiEffShortQ]);
        expect(e.tradeFeeBaseBps).toBe(wcfg.tradeFeeBps);
        expect(e.lpFeeAccruedAtoms).toBe(wcfg.lpFeeAccruedAtoms);
        expect(e.lpFeeWithdrawnAtoms).toBe(wcfg.lpFeeWithdrawnAtoms);
        // Sanity on the fields no SDK parser exposes (config prefix did not move): plausible live values.
        expect(e.initialMarginBps > 0n && e.initialMarginBps <= 10_000n).toBe(true);
        expect(e.maintenanceMarginBps > 0n && e.maintenanceMarginBps <= e.initialMarginBps).toBe(true);
        expect(e.maxTradingFeeBps >= e.tradeFeeBaseBps && e.maxTradingFeeBps <= 10_000n).toBe(true);
        expect([0, 1, 2, 3]).toContain(e.modeLong);
        expect([0, 1, 2, 3]).toContain(e.modeShort);
        // The engine clock: the app's two readers agree.
        expect(readV17AssetSlotLast(d, i) ?? 0n).toBe(u64(d, eng + 41));
      }
    });
  }
});

describe("D-1: per-asset wrapper-slot records (risk limits, vault LP, growth, fee inputs)", () => {
  for (const [name, m] of Object.entries(MARKETS)) {
    it(`${name}: risk-limit record, vault-LP record, growth record and the fee inputs agree with the SDK`, () => {
      const d = b(m.marketB64);
      for (let i = 0; i < slotsOf(d); i++) {
        const sdkRl = decodeAssetRiskLimitsP1(d, i);
        const rl = D.decodeAssetRiskLimits(d, i);
        expect(rl, `risk limits asset ${i}`).not.toBeNull();
        expect({ a: rl!.sideOiCapQ, b: rl!.lpFloorAtoms, c: rl!.lpExposureKBps, d: rl!.execBandBps, e: rl!.matcherExtMode, f: rl!.maxRequestedFeeBps })
          .toEqual({ a: sdkRl.sideOiCapQ, b: sdkRl.lpFloorAtoms, c: sdkRl.lpExposureKBps, d: sdkRl.execBandBps, e: sdkRl.matcherExtMode, f: sdkRl.maxRequestedFeeBps });
        expect(() => decodeAdlEpisode(d, i)).not.toThrow();

        const sdkAvl = decodeAssetVaultLpP3(d, i);
        const avl = D.decodeAssetVaultLp(d, i);
        expect(avl, `vault LP asset ${i}`).not.toBeNull();
        expect(avl!.bound).toBe(sdkAvl.bound);
        expect(avl!.bound ? pk(avl!.vaultLpPortfolio) : null).toBe(sdkAvl.vaultLpPortfolio ? sdkAvl.vaultLpPortfolio.toBase58() : null);
        expect(pk(avl!.approvedMatcherProgram)).toBe((sdkAvl.approvedMatcherProgram ?? PublicKey.default).toBase58());
        expect([avl!.lpNetQ, avl!.levCapQ, avl!.lpNetSlot, avl!.skewSlopeE9, avl!.skewMaxE9, avl!.levMaxImrBps, avl!.vaultLpMaxLevBps])
          .toEqual([sdkAvl.lpNetQ, sdkAvl.levCapQ, sdkAvl.lpNetSlot, sdkAvl.skewSlopeE9, sdkAvl.skewMaxE9, sdkAvl.levMaxImrBps, sdkAvl.vaultLpMaxLevBps]);
        expect(avl!.creatorFeeVesting === true).toBe(sdkAvl.creatorFeeVesting);

        expect(decodeGrowthRecord(d, i)).toEqual(decodeAssetGrowthV19(d, i));
        const g = decodeAssetGrowthV19(d, i);
        expect(utilFeeMaxBpsOf(d, i)).toBe(g ? utilFeeMaxEffectiveBps(g.utilFeeMaxBps) : 0);

        const fee = readTradeFeeInputsApp(d, i, m.matcherCtxB64 ? b(m.matcherCtxB64) : null)!;
        expect(fee.maxRequestedFeeBps).toBe(sdkRl.maxRequestedFeeBps);
        expect(fee.matcherExtMode).toBe(sdkRl.matcherExtMode);
        expect(fee.tradeFeeBaseBps).toBe(v22Slab.parseWrapperConfigV17(d).tradeFeeBps);
      }
    });
  }
});

describe("D-1: vault-LP state + LP registry", () => {
  for (const [name, m] of Object.entries(MARKETS)) {
    if (!m.vaultLpStateB64 || !m.registryB64) continue;
    it(`${name}: vault-LP state and registry agree with the SDK`, () => {
      const vs = b(m.vaultLpStateB64!);
      const sdk = decodeVaultLpStateP3(vs);
      const app = D.decodeVaultLpState(vs)!;
      expect(app).not.toBeNull();
      expect({ ...app, lpPortfolio: pk(app.lpPortfolio), juniorOwner: pk(app.juniorOwner) }).toEqual({
        seniorClaimAtoms: sdk.seniorClaimAtoms, juniorDepositedAtoms: sdk.juniorDepositedAtoms, juniorWithdrawnAtoms: sdk.juniorWithdrawnAtoms,
        seniorFeeCreditedAtoms: sdk.seniorFeeCreditedAtoms, recalledAtoms: sdk.recalledAtoms, assetIndex: sdk.assetIndex, juniorFloorBps: sdk.juniorFloorBps,
        seniorFeeShareBps: sdk.seniorFeeShareBps, lpPortfolio: sdk.lpPortfolio.toBase58(), juniorOwner: sdk.juniorOwner.toBase58(),
        seniorDrawnAtoms: sdk.seniorDrawnAtoms, seniorDrawOutstandingAtoms: sdk.seniorDrawOutstandingAtoms,
      });
      const reg = b(m.registryB64!);
      const sreg = v22Slab.parseLpVaultRegistry(reg);
      expect(D.decodeLpVaultRegistryShares(reg)).toBe(sreg.totalLpSharesOutstanding);
      expect(D.decodeLpVaultRegistryOiThresholdBps(reg)).toBe(sreg.oiReservationThresholdBps);
      expect(D.decodeLpVaultRegistryDomain(reg)).toBe(sreg.domain);
      expect(D.decodeLpVaultRegistryBound(reg)).toBe(decodeAssetVaultLpP3(b(m.marketB64), 0).bound);
    });
  }
});

describe("D-1: portfolio + legs", () => {
  const all: Array<[string, Uint8Array]> = [
    ...Object.entries(MARKETS).filter(([, m]) => m.lpPortfolioB64).map(([n, m]) => [`${n} LP`, b(m.lpPortfolioB64!)] as [string, Uint8Array]),
    ...Object.entries(PORTFOLIOS).map(([n, p]) => [n, b(p.dataB64)] as [string, Uint8Array]),
  ];
  it("the fixture has positioned portfolios (legs to compare)", () => {
    expect(all.filter(([, d]) => v22Slab.parsePortfolioV17(d).legs.some((l) => l.active)).length).toBeGreaterThanOrEqual(3);
  });
  for (const [name, d] of all) {
    it(`${name}: risk view, legs and geometry agree with the SDK parser`, () => {
      const sdk = v22Slab.parsePortfolioV17(d);
      const P = resolvePortfolioLayout(d, { parser: "t" }).portfolio;
      const geo = portfolioLegGeometry(d)!;
      expect([geo.legsOff, geo.legStride, geo.legCount]).toEqual([P.legsOff, P.legStride, P.legCount]);
      expect(parsePortfolio(d)).toEqual(sdk);
      const r = D.decodePortfolioRisk(d)!;
      expect({ owner: pk(r.owner), capital: r.capital, pnl: r.pnl, feeCredits: r.feeCredits, activeBitmap: r.activeBitmap })
        .toEqual({ owner: sdk.owner.toBase58(), capital: sdk.capital, pnl: sdk.pnl, feeCredits: sdk.feeCredits, activeBitmap: sdk.activeBitmap });
      const active = sdk.legs.map((l, slot) => ({ l, slot })).filter((x) => x.l.active);
      expect(D.decodePortfolioLegs(d)).toEqual(active.map(({ l, slot }) => ({ slot, assetIndex: l.assetIndex, side: l.side, basisPosQ: l.basisPosQ })));
      for (const { l } of active) {
        const mag = l.basisPosQ < 0n ? -l.basisPosQ : l.basisPosQ;
        expect(D.signedPositionForAsset(d, l.assetIndex, l.marketId)).toBe(l.side === 0 ? mag : -mag);
      }
      // Fields after the legs (no SDK parser): the stale bytes are booleans and a current certificate carries the bitmap.
      expect([0, 1]).toContain(r.staleState);
      expect([0, 1]).toContain(r.bStaleState);
      expect([0, 1]).toContain(r.cert.validByte);
      if (r.cert.validByte === 1) expect(r.cert.activeBitmapAtCert).toBe(sdk.activeBitmap);
    });
  }
});

describe("D-1: matcher context", () => {
  for (const [name, m] of Object.entries(MARKETS)) {
    if (!m.matcherCtxB64 || !m.lpPortfolioB64) continue;
    it(`${name}: decodes, and its inventory is the LP's position (independent cross-check)`, () => {
      const ctx = D.decodeMatcherCtx(b(m.matcherCtxB64!))!;
      expect(ctx).not.toBeNull();
      expect([0, 1, 2]).toContain(ctx.kind);
      if (name !== "MULTI5") expect(ctx.kind).toBe(2); // every preview market runs the vAMM kind; the test market's is passive
      if (ctx.kind === 2) expect(ctx.maxTotalBps).toBeGreaterThanOrEqual(ctx.tradingFeeBps + ctx.baseSpreadBps);
      if (!ctx.v2) return; // a v1 context (the multi-asset test market): no v2 block to check
      expect(ctx.v2.feeHiBps).toBeGreaterThanOrEqual(ctx.v2.feeLoBps);
      const asset = ctx.v2.boundAssetPlus1 - 1;
      if (asset < 0) return; // not bound to an asset
      // inventory_base is the bound asset's LP position as of the last fill (same sign convention).
      const avl = decodeAssetVaultLpP3(b(m.marketB64), asset);
      if (avl.bound && avl.vaultLpPortfolio.toBase58() === m.lpPortfolio) expect(ctx.inventoryBase).toBe(avl.lpNetQ);
    });
  }
});

describe("D-1: stake pool (v5)", () => {
  it("every captured pool is 480 bytes and decodes as v5; the prefix the pools route reads by offset agrees", () => {
    for (const [addr, raw] of Object.entries(POOLS)) {
      const d = b(raw);
      expect(d.length, addr).toBe(STAKE_POOL_SIZE_V5);
      const p = decodeStakePoolV5(d);
      expect(pk(d.subarray(8, 40))).toBe(p.slab.toBase58());
      expect(pk(d.subarray(104, 136))).toBe(p.lpMint.toBase58());
      expect(pk(d.subarray(136, 168))).toBe(p.vault.toBase58());
      expect(u64(d, 168)).toBe(p.totalDeposited);
      expect(u64(d, 176)).toBe(p.totalLpSupply);
      expect(u64(d, 184)).toBe(p.cooldownSlots);
      expect(u64(d, 192)).toBe(p.depositCap);
      expect(u64(d, 200)).toBe(p.totalFlushed);
      expect(u64(d, 208)).toBe(p.totalReturned);
      expect(u64(d, 216)).toBe(p.totalWithdrawn);
      expect(d[280]).toBe(p.poolMode);
    }
  });

  it("FIX (pre-resolve): the v5 pool decodes on v2.2; NEGATIVE CONTROL: the installed decoder refuses it", () => {
    const [addr, raw] = Object.entries(POOLS)[0];
    const d = b(raw);
    const sdk = decodeStakePoolV5(d);
    const p = decodePreResolvePool(d);
    expect({ slab: p.slab.toBase58(), vault: p.vault.toBase58(), prog: p.percolatorProgram.toBase58(), mode: p.poolMode, supply: p.totalLpSupply, init: p.isInitialized })
      .toEqual({ slab: sdk.slab.toBase58(), vault: sdk.vault.toBase58(), prog: sdk.percolatorProgram.toBase58(), mode: sdk.poolMode, supply: sdk.totalLpSupply, init: true });
    __setDevnetV22ForTest(false);
    expect(() => decodePreResolvePool(d), addr).toThrow(/version/i);
  });
});

describe("D-1 FIX (self-heal catch-up): the engine clock and header slot are read at the v2.2 offsets", () => {
  for (const [name, m] of Object.entries(MARKETS)) {
    it(`${name}: lag = max(read slot, header current_slot) - asset 0 slot_last, as the layout-aware readers see it`, () => {
      const d = b(m.marketB64);
      const e = D.decodeMarketEngineView(d, 0)!;
      const slotLast = readV17AssetSlotLast(d, 0)!;
      expect(slotLast > 500_000_000n).toBe(true);
      const read = e.currentSlot + 1_000n;
      const plan = planCatchUp(d, read, 200_000);
      expect(plan.lagSlots).toBe(read - slotLast);
      expect(plan.dtSlots !== null && plan.dtSlots > 0n).toBe(true);
      expect(plan.k > 0 || plan.beyondCap).toBe(true);
    });
  }
  it("NEGATIVE CONTROL: the v2.1 offsets (flag-off path) read no clock from a v2.2 account, so nothing was planned", () => {
    const d = b(MARKETS.PENGU.marketB64);
    const read = D.decodeMarketEngineView(d, 0)!.currentSlot + 1_000n;
    const slotLast = readV17AssetSlotLast(d, 0)!;
    __setDevnetV22ForTest(false);
    const stale = planCatchUp(d, read, 200_000);
    expect(stale.lagSlots).not.toBe(read - slotLast);
  });
});

describe("D-1 FIX (launch recovery): a v2.2 InitMarket (219 bytes + trailer) is recognised", () => {
  const derived = deriveLaunchMarketParams({ initialMarginBps: 1000, lpCollateral: 1_000_000_000n, initialPriceE6: 3695n });
  const base = encodeInitMarket(buildV17InitMarketArgs({ initialPriceE6: 3695n, tradingFeeBps: 5 }, derived));
  const v22 = new Uint8Array([...base, ...encodeInitMarketTrailerV22({ rGapBps: 500, lLaunchX100: 800, lotExp: 4 })]);
  it("reads the same facts from the v2.2 payload as from its 219-byte prefix", () => {
    expect(base.length).toBe(219);
    expect(v22.length).toBeGreaterThan(219);
    const facts = decodeInitMarketData(v22);
    expect(facts).not.toBeNull();
    expect(facts).toEqual(decodeInitMarketData(base));
    expect(facts!.initialPriceE6).toBe(3695n);
  });
  it("NEGATIVE CONTROL: flag off keeps the exact length (a longer payload is not an InitMarket there)", () => {
    __setDevnetV22ForTest(false);
    expect(decodeInitMarketData(v22)).toBeNull();
    expect(decodeInitMarketData(base)).not.toBeNull();
  });
});
