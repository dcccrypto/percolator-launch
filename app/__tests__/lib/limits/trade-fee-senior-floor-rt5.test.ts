/**
 * v2.2 QA RT5-1 (2026-10-12): QA's 10k PENGU long could not be closed from the app: every close failed at
 * simulation with InstructionError [2, Custom 9]. The app signed fee_bps 35 (base 30 + 5) where the program
 * needs base + the matcher's request (~23) <= the signed cap. Cause: on v2.2 record bytes [42, 64) of
 * AssetRiskLimitsV17 are no longer reserved ([42, 44) = Earn senior floor code, [44, 64) = ADL wind-down);
 * the app decoder still required zeros, so once PENGU had Earn seniors the record read as "unreadable" and
 * the fee channel as off. Bytes: the REAL PENGU market + matcher context and the REAL refused instruction.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixture from "../../fixtures/v22-pengu-senior-floor-2026-10-12.json";
import v18 from "../../fixtures/Azagguvr.market.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";
import * as C from "@/lib/limits/constants";
import { decodeAssetRiskLimits, decodeMarketEngineView, decodeMatcherCtx } from "@/lib/limits/decode";
import { requestedFeeBps, requestedFeePermitted } from "@/lib/limits/fee-channel";
import { preTradeQuote } from "@/lib/limits/matcher-quote";
import { readTradeFeeInputsApp, resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { decodeAssetRiskLimitsP1 } from "@/lib/v22/sdk/records/risk-limits-p1";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const market = () => bytes(fixture.marketB64);
const ctx = () => bytes(fixture.matcherCtxB64);
const recordOff = (d: Uint8Array) => marketOffsets(d, "test").wrapperOff(0) + C.ASSET_RISK_LIMITS_OFF;
/** fee_bps (u64 LE) of a TradeCpi instruction: tag 1 + 5 u64 + u16 + u64 + i128 = byte 67. */
const signedFeeOf = (hex: string) => Buffer.from(hex, "hex").readBigUInt64LE(67);
/** The matcher's request for closing the 1-lot long (a sell of 1,000,000 q). */
function liveRequest(d: Uint8Array): bigint {
  const e = decodeMarketEngineView(d)!;
  const q = preTradeQuote(decodeMatcherCtx(ctx())!, e.effectivePriceE6, 1_000_000n, false)!;
  return requestedFeeBps(e.effectivePriceE6, q.quotePriceE6!);
}
const accepts = (d: Uint8Array, signed: bigint, req: bigint) => {
  const e = decodeMarketEngineView(d)!;
  return requestedFeePermitted(req, e.tradeFeeBaseBps, signed, 100, e.maxTradingFeeBps);
};

describe("RT5-1: PENGU with an Earn senior floor in the risk-limit record", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));

  it("the real record has the senior floor code at [42, 44) and nothing else in the old reserved tail", () => {
    const d = market();
    const b = recordOff(d);
    expect(Buffer.from(d.subarray(b + 42, b + 44)).toString("hex")).toBe("be4b");
    expect(d.subarray(b + 44, b + 64).every((x) => x === 0)).toBe(true);
  });

  it("the app decoder reads the same dials as the SDK decoder (channel on: mode 1, max_requested 100)", () => {
    const d = market();
    const rl = decodeAssetRiskLimits(d, 0);
    expect(rl).not.toBeNull();
    const sdk = decodeAssetRiskLimitsP1(d, 0);
    expect({ m: rl!.matcherExtMode, r: rl!.maxRequestedFeeBps, f: rl!.lpFloorAtoms }).toEqual({ m: sdk.matcherExtMode, r: sdk.maxRequestedFeeBps, f: sdk.lpFloorAtoms });
    expect(rl!.maxRequestedFeeBps).toBe(100);
    expect(rl!.matcherExtMode).toBe(1);
  });

  it("the close signs 135, which the program accepts for the live matcher request; the refused tx signed 35", () => {
    const d = market();
    expect(readTradeFeeInputsApp(d, 0, ctx())).toEqual({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 700n, maxRequestedFeeBps: 100, matcherExtMode: 1, matcherMaxTotalBps: 100 });
    const r = resolveTradeFeeBps({ marketData: d, matcherCtxData: ctx() })!;
    expect(r.feeBps).toBe(135n);
    const req = liveRequest(d);
    expect(req).toBeGreaterThan(5n);
    expect(accepts(d, r.feeBps, req)).toBe(true);
    for (const any of [0n, 100n]) expect(accepts(d, r.feeBps, any)).toBe(true);
    // The instruction QA's close actually simulated (refused Custom 9): fee_bps 35.
    const refused = signedFeeOf(fixture.refusedCloseTradeCpiDataHex);
    expect(refused).toBe(35n);
    expect(accepts(d, refused, req)).toBe(false);
  });

  it("a wind-down length over the program maximum (9,000 slots) is still refused, as the program does", () => {
    const d = market();
    const b = recordOff(d);
    new DataView(d.buffer).setUint32(b + 44, 9_000, true);
    expect(decodeAssetRiskLimits(d, 0)).not.toBeNull();
    new DataView(d.buffer).setUint32(b + 44, 9_001, true);
    expect(decodeAssetRiskLimits(d, 0)).toBeNull();
  });

  it("allDefault ignores the senior floor lane (dials all zero + a floor code = defaults)", () => {
    const d = market();
    const b = recordOff(d);
    d.fill(0, b, b + 42);
    expect(decodeAssetRiskLimits(d, 0)!.allDefault).toBe(true);
  });

  it("before v2.2 (flag off) nothing changes: a v18 market decodes, and a non-zero reserved tail is still refused", () => {
    __setDevnetV22ForTest(false);
    const d = bytes(v18.dataBase64);
    const b = marketOffsets(d, "test").wrapperOff(0) + C.ASSET_RISK_LIMITS_OFF;
    expect(decodeAssetRiskLimits(d, 0)).not.toBeNull();
    d[b + 42] = 0xbe;
    expect(decodeAssetRiskLimits(d, 0)).toBeNull();
  });
});
