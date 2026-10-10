import { afterEach, describe, expect, it } from "vitest";
import { readAssetPricesP3 as installedReadPrices } from "@percolatorct/sdk";
import { decodeAssetGrowthV19 as v21DecodeGrowth } from "@/lib/v21/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V21, LAYOUT_V22, UnknownLayoutError, WRAPPER_ACCOUNT_MAGIC, type LayoutTable } from "@/lib/v22/sdk";
import { decodeAssetGrowthV19, readAssetPricesP3, decodeAdlEpisode } from "@/lib/v22/records";
import { readBankruptcyHlockActive } from "@/lib/v21/growth-market";
import { decodeMarketHealth } from "@/lib/market-health";

const EFF = 123_456_789n;
const RAW = 987_654_321n;
const LAMBDA = 7_777;

function market(L: LayoutTable, version = L.version, slots = 1, totalLen?: number): Uint8Array {
  const len = totalLen ?? L.marketGroupOff + L.marketGroupLen + slots * L.assetSlotStride;
  const d = new Uint8Array(len);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, version, true);
  d[10] = ACCOUNT_KIND.Market;
  const slot = L.marketGroupOff + L.marketGroupLen; // asset 0
  const eng = slot + L.wrapperSlotLen;
  v.setBigUint64(eng + L.assetState.effectivePrice, EFF, true);
  v.setBigUint64(eng + L.assetState.rawOracleTargetPrice, RAW, true);
  // growth record at slot + wrapperSlot.growth: version 1, lambda
  const g = slot + L.wrapperSlot.growth;
  d[g + 38] = 1;
  v.setUint32(g + 16, LAMBDA, true);
  // bankruptcy h-lock byte = mode - 5 within the group
  d[L.marketGroupOff + L.group.mode - 5] = 3;
  return d;
}

afterEach(() => __setDevnetV22ForTest(null));

describe("records adapter: flag OFF is today's behaviour", () => {
  it("equals the installed / v2.1 port on a v2.1 buffer", () => {
    __setDevnetV22ForTest(false);
    const d = market(LAYOUT_V21);
    expect(readAssetPricesP3(d, 0)).toEqual(installedReadPrices(d, 0));
    expect(readAssetPricesP3(d, 0).effectivePriceE6).toBe(EFF);
    expect(decodeAssetGrowthV19(d, 0)).toEqual(v21DecodeGrowth(d, 0));
    expect(decodeAssetGrowthV19(d, 0)?.lambdaBps).toBe(LAMBDA);
    expect(readBankruptcyHlockActive(d)).toBe(true);
  });
});

describe("records adapter: flag ON decodes by VERSION", () => {
  it("decodes v2.1 and v2.2 buffers with their own geometry", () => {
    __setDevnetV22ForTest(true);
    for (const L of [LAYOUT_V21, LAYOUT_V22]) {
      const d = market(L);
      expect(readAssetPricesP3(d, 0)).toEqual({ effectivePriceE6: EFF, rawOracleTargetPriceE6: RAW });
      expect(decodeAssetGrowthV19(d, 0)?.lambdaBps).toBe(LAMBDA);
      expect(readBankruptcyHlockActive(d)).toBe(true);
    }
  });

  it("NEGATIVE CONTROL: the installed / v2.1 readers misread a v2.2 buffer (the bug class is real)", () => {
    const d = market(LAYOUT_V22);
    expect(installedReadPrices(d, 0).effectivePriceE6).not.toBe(EFF);
    expect(v21DecodeGrowth(d, 0)?.lambdaBps).not.toBe(LAMBDA);
  });

  it("refuses an unknown VERSION with the typed error", () => {
    __setDevnetV22ForTest(true);
    const d = market(LAYOUT_V22, 20);
    expect(() => readAssetPricesP3(d, 0)).toThrow(UnknownLayoutError);
    expect(() => decodeAssetGrowthV19(d, 0)).toThrow(UnknownLayoutError);
    expect(() => decodeAdlEpisode(d, 0)).toThrow(UnknownLayoutError);
    expect(() => decodeMarketHealth(d, 0n, null)).toThrow(UnknownLayoutError);
    expect(readBankruptcyHlockActive(d)).toBe(false); // calm: claims nothing
  });

  it("a v2.1 buffer padded to a v2.2 stride length is still decoded as v2.1 (VERSION, never length)", () => {
    __setDevnetV22ForTest(true);
    const d = market(LAYOUT_V21, 18, 1, LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + LAYOUT_V22.assetSlotStride);
    expect(readAssetPricesP3(d, 0).effectivePriceE6).toBe(EFF);
    expect(decodeAssetGrowthV19(d, 0)?.lambdaBps).toBe(LAMBDA);
  });
});

describe("market-health geometry", () => {
  it("reads the mode / h-lock bytes of each VERSION from the table", () => {
    __setDevnetV22ForTest(true);
    for (const L of [LAYOUT_V21, LAYOUT_V22]) {
      const d = market(L);
      d[L.marketGroupOff + L.group.mode] = 1; // Resolved
      const h = decodeMarketHealth(d, 0n, null);
      expect(h.mode).toBe(1);
      expect(h.bankruptcyHlock).toBe(true);
    }
  });
});

// ── legacy constant readers migrated to the layout (self-heal, limits/decode, earn-split-pot, first-trade) ──
import { decodeMarketLiveness } from "@/lib/self-heal";
import { decodeMarketEngineView, decodeAssetRiskLimits, decodeResolvedMarket } from "@/lib/limits/decode";
import { decodeBackingBucket } from "@/lib/limits/earn-split-pot";
import { readNextPortfolioId } from "@/lib/first-trade";
import { marketOffsets } from "@/lib/v22/market-offsets";

/** v2.1 and v2.2 buffer with distinctive values at the TABLE offsets of the fields these readers use. */
function legacyMarket(L: LayoutTable): Uint8Array {
  const d = market(L);
  const v = new DataView(d.buffer);
  const g = L.marketGroupOff;
  v.setBigUint64(g + L.group.currentSlot, 4242n, true);
  v.setUint32(g + L.group.config + L.group.maxMarketSlotsInConfig, 1, true);
  d[g + L.group.mode] = 0;
  v.setBigUint64(g + L.group.vault, 0n, true);
  const slot = g + L.marketGroupLen;
  const eng = slot + L.wrapperSlotLen;
  // backing bucket long: status @96 = fresh, expiry @88
  v.setBigUint64(eng + L.engineSlot.backingLong + 88, 9_999n, true);
  d[eng + L.engineSlot.backingLong + 96] = 1;
  // next_portfolio_id in the oracle profile (wrapper prefix, does not move)
  v.setBigUint64(slot + 480, 77n, true);
  return d;
}

describe("legacy constant readers follow the layout", () => {
  it("flag off: v2.1 results unchanged", () => {
    __setDevnetV22ForTest(false);
    const d = legacyMarket(LAYOUT_V21);
    const h = decodeMarketLiveness(d, 0n);
    expect(h.nowSlot).toBe(4242n);
    expect(h.buckets[0]).toMatchObject({ status: 1, expirySlot: 9_999n });
    expect(readNextPortfolioId(d)).toBe(77n);
    expect(decodeMarketEngineView(d, 0)?.currentSlot).toBe(4242n);
  });

  it("flag on: v2.1 and v2.2 both decode with their own geometry", () => {
    __setDevnetV22ForTest(true);
    for (const L of [LAYOUT_V21, LAYOUT_V22]) {
      const d = legacyMarket(L);
      const h = decodeMarketLiveness(d, 0n);
      expect(h.nowSlot).toBe(4242n);
      expect(h.buckets[0]).toMatchObject({ status: 1, expirySlot: 9_999n });
      expect(decodeBackingBucket(d, 0)).toMatchObject({ status: 1, expirySlot: 9_999n });
      expect(readNextPortfolioId(d)).toBe(77n);
      expect(decodeMarketEngineView(d, 0)?.currentSlot).toBe(4242n);
      expect(decodeMarketEngineView(d, 0)?.effectivePriceE6).toBe(EFF);
      expect(decodeAssetRiskLimits(d, 0)).not.toBeUndefined();
      expect(decodeResolvedMarket(d)?.currentSlot).toBe(4242n);
    }
  });

  it("NEGATIVE CONTROL: the v2.1 constants misread a v2.2 buffer", () => {
    __setDevnetV22ForTest(false); // flag off = constants only
    const d = legacyMarket(LAYOUT_V22);
    expect(decodeMarketLiveness(d, 0n).nowSlot).not.toBe(4242n);
    expect(readNextPortfolioId(d)).not.toBe(77n);
  });

  it("unknown VERSION: liveness throws typed, the null-returning readers return null", () => {
    __setDevnetV22ForTest(true);
    const d = market(LAYOUT_V22, 20);
    expect(() => decodeMarketLiveness(d, 0n)).toThrow(UnknownLayoutError);
    expect(decodeMarketEngineView(d, 0)).toBeNull();
    expect(decodeBackingBucket(d, 0)).toBeNull();
    expect(readNextPortfolioId(d)).toBeNull();
  });

  it("offset helper: v2.2 header shift is 48 and slot shift is 112 (from the table)", () => {
    __setDevnetV22ForTest(true);
    const M = marketOffsets(market(LAYOUT_V22));
    expect(M.hdr(285)).toBe(LAYOUT_V22.marketGroupOff + LAYOUT_V22.group.vault);
    expect(M.hdr(626)).toBe(LAYOUT_V22.marketGroupOff + LAYOUT_V22.group.mode);
    expect(M.slotRel(963)).toBe(LAYOUT_V22.engineSlot.backingLong);
    expect(M.slotRel(595)).toBe(LAYOUT_V22.engineSlot.sourceCreditLong);
    expect(M.hdr(32)).toBe(LAYOUT_V22.marketGroupOff + 32);
  });
});
