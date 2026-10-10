// @vitest-environment node
/**
 * lib/v22/layout.ts: the one place that decides account geometry.
 *  - flag OFF: byte-for-byte what the v2.1 constants / installed SDK 8.0.0 gave (parity against the old constants);
 *  - flag ON : geometry chosen by the account's VERSION; unknown VERSION refused with the SDK's typed error;
 *    a v2.1 buffer whose LENGTH happens to look like a v2.2 stride is still decoded as v2.1 (never by length).
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, SystemInstruction } from "@solana/web3.js";
import {
  V17_MARKET_ASSET_SLOT_LEN, V17_MARKET_GROUP_LEN, V17_MARKET_GROUP_OFF, V17_PORTFOLIO_ACCOUNT_LEN, V17_ASSET_ORACLE_WRAPPER_LEN,
  parseMarketGroupV17OI, parsePortfolioV17,
} from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import {
  activeLayout, createPortfolioAccountIx, isPortfolioOfActiveLayout, isUnknownWrapperVersion, isUnsupportedLayout, isWrapperAccount,
  isWrapperMarketAccount, layoutOf, marketGeometry, parseMarketOI, parsePortfolio, portfolioAccountLen, portfolioGpaFilters,
  portfolioLegGeometry, unsupportedLayoutBody, UnknownLayoutError,
} from "@/lib/v22/layout";
import { LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk";
import { readAssetMarketId, assetProfileOff } from "@/lib/v18-wire";
import { readV17AssetSlotLast } from "@/lib/v17-engine-clock";
import { decodePortfolioLegs, signedPositionForAsset } from "@/lib/limits/decode";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import { stampHeader, syntheticMarket, syntheticPortfolio } from "./_stamp";

afterEach(() => __setDevnetV22ForTest(null));

describe("flag OFF: identical to the v2.1 constants", () => {
  it("lengths and geometry equal the installed SDK constants", () => {
    __setDevnetV22ForTest(false);
    expect(portfolioAccountLen()).toBe(V17_PORTFOLIO_ACCOUNT_LEN);
    expect(activeLayout()).toBe(LAYOUT_V21);
    const g = marketGeometry(new Uint8Array(0));
    expect(g.groupOff).toBe(V17_MARKET_GROUP_OFF);
    expect(g.slotsBase).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN);
    expect(g.slotOff(2)).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + 2 * V17_MARKET_ASSET_SLOT_LEN);
    expect(g.engineOff(1)).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_MARKET_ASSET_SLOT_LEN + V17_ASSET_ORACLE_WRAPPER_LEN);
  });
  it("createAccount instruction is byte-identical to the old inline one", () => {
    __setDevnetV22ForTest(false);
    const payer = Keypair.generate().publicKey, pf = Keypair.generate().publicKey, prog = Keypair.generate().publicKey;
    const ix = createPortfolioAccountIx(payer, pf, 123, prog);
    const d = SystemInstruction.decodeCreateAccount(ix);
    expect([Number(d.space), d.lamports, d.programId.toBase58()]).toEqual([V17_PORTFOLIO_ACCOUNT_LEN, 123, prog.toBase58()]);
  });
  it("decoders delegate to the installed SDK (same output on v2.1 bytes); a v2.2 buffer is NOT silently decoded", () => {
    __setDevnetV22ForTest(false);
    const m = syntheticMarket(LAYOUT_V21, 2);
    expect(parseMarketOI(m)).toEqual(parseMarketGroupV17OI(m));
    const p = syntheticPortfolio(LAYOUT_V21);
    expect(parsePortfolio(p).capital).toBe(parsePortfolioV17(p).capital);
    expect(isWrapperAccount(syntheticMarket(LAYOUT_V22, 1))).toBe(false); // flag off: v2.2 is not a v2.1 account
    expect(isUnknownWrapperVersion(syntheticMarket(LAYOUT_V22, 1))).toBe(false);
    expect(portfolioGpaFilters()).toEqual([{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }]);
  });
});

describe("flag ON: VERSION-keyed geometry", () => {
  it("v2.2 lengths and the VERSION memcmp", () => {
    __setDevnetV22ForTest(true);
    expect(portfolioAccountLen()).toBe(10603);
    expect(LAYOUT_V22.portfolio.accountLen).toBe(10603);
    const f = portfolioGpaFilters();
    expect(f[0]).toEqual({ dataSize: 10603 });
    expect(f[1]).toHaveProperty("memcmp.offset", 8);
  });
  it("a v2.2 market decodes with v2.2 offsets, and the v2.1 stride would read different numbers", () => {
    __setDevnetV22ForTest(true);
    const m = syntheticMarket(LAYOUT_V22, 2, { insurance: 4242n, oiLongSlot1: 7n });
    const oi = parseMarketOI(m);
    expect([oi.insuranceBalance, oi.totalLongOiQ]).toEqual([4242n, 7n]);
    // NEGATIVE CONTROL: the installed (v2.1-offset) decoder refuses the VERSION, and a raw v2.1-offset read of the same bytes differs.
    expect(() => parseMarketGroupV17OI(m)).toThrow();
    const v21Off = V17_MARKET_GROUP_OFF + 301;
    const raw21 = new DataView(m.buffer).getBigUint64(v21Off, true);
    expect(raw21).not.toBe(4242n);
    expect(marketGeometry(m).slotsBase).toBe(592 + 806);
  });
  it("a v2.1 market still decodes under the flag (dual wrapper)", () => {
    __setDevnetV22ForTest(true);
    const m = syntheticMarket(LAYOUT_V21, 2, { insurance: 9n, oiLongSlot1: 3n });
    const oi = parseMarketOI(m);
    expect([oi.insuranceBalance, oi.totalLongOiQ]).toEqual([9n, 3n]);
    expect(isWrapperMarketAccount(m)).toBe(true);
  });
  it("decodes by VERSION, not length: a v2.1 buffer sized like a v2.2 market is read as v2.1", () => {
    __setDevnetV22ForTest(true);
    // 1 v2.2 slot + group is 592+806+2661 = 4059 bytes; make a v2.1-stamped buffer of exactly that length.
    const len = LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + LAYOUT_V22.assetSlotStride;
    const d = stampHeader(new Uint8Array(len), 1, 18);
    expect(marketGeometry(d).layout.version).toBe(18);
    expect(marketGeometry(d).slotsBase).toBe(592 + 758);
  });
  it("unknown VERSION is refused with the typed error (and flagged for the fallback UI), never decoded", () => {
    __setDevnetV22ForTest(true);
    const m = stampHeader(new Uint8Array(4100), 1, 20);
    let err: unknown;
    try { parseMarketOI(m); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnknownLayoutError);
    expect(isUnsupportedLayout(err)).toBe(true);
    expect((err as UnknownLayoutError).code).toBe("UNKNOWN_VERSION");
    expect(isUnknownWrapperVersion(m)).toBe(true);
    expect(isWrapperAccount(m)).toBe(false);
    expect(() => marketGeometry(m)).toThrow(UnknownLayoutError);
    expect(() => layoutOf(m, "t")).toThrow(UnknownLayoutError);
    expect(unsupportedLayoutBody(err)).toEqual({ error: "unsupported_layout", message: expect.any(String), version: 20 });
    // the body never leaks offsets or the word "version" digits beyond the numeric field
    expect(unsupportedLayoutBody(err).message).not.toMatch(/\d/);
  });
  it("readers that return null on an unknown VERSION do so instead of reading", () => {
    __setDevnetV22ForTest(true);
    const m = stampHeader(new Uint8Array(4100), 1, 20);
    expect(readV17AssetSlotLast(m, 0)).toBeNull();
    expect(() => readAssetMarketId(m, 0)).toThrow(UnknownLayoutError);
    expect(() => assetProfileOff(0)).toThrow(); // no bytes under the flag: refuses to guess
  });
  it("portfolio: leg geometry, epoch snap and legs decode at v2.2 offsets; v2.1 offsets would misread", () => {
    __setDevnetV22ForTest(true);
    const p = syntheticPortfolio(LAYOUT_V22);
    const geo = portfolioLegGeometry(p)!;
    expect([geo.legStride, geo.afterLegsShift]).toEqual([217, 16 * (217 - 152)]);
    const pf = parsePortfolio(p);
    expect(pf.capital).toBe(1234n);
    expect(pf.legs[0].epochSnap).toBe(99n);
    expect(decodePortfolioLegs(p).map((l) => [l.assetIndex, l.side, l.basisPosQ])).toEqual([[3, 1, 42n]]);
    expect(signedPositionForAsset(p, 3, 0n)).toBe(-42n); // short leg on asset 3 (market id 0 in the synthetic leg)
    expect(signedPositionForAsset(p, 3, 7n)).toBe(0n); // another market id: no false hit
    // NEGATIVE CONTROL: a v2.1-stride read of the same bytes finds no/other legs.
    const v21Slot1Active = p[LAYOUT_V21.portfolio.legsOff + 1 * LAYOUT_V21.portfolio.legStride + 0];
    expect(v21Slot1Active).not.toBe(1);
    expect(isPortfolioAccount(p)).toBe(true);
    expect(isPortfolioOfActiveLayout(p)).toBe(true);
  });
  it("portfolio with a wrong engine discriminator is refused, and a v2.1 portfolio length is not a v2.2 portfolio", () => {
    __setDevnetV22ForTest(true);
    const bad = syntheticPortfolio(LAYOUT_V22, { discriminator: 18 });
    expect(() => parsePortfolio(bad)).toThrow(UnknownLayoutError);
    expect(isPortfolioAccount(syntheticPortfolio(LAYOUT_V21))).toBe(true); // its own VERSION's length
    const shortV22 = stampHeader(new Uint8Array(LAYOUT_V21.portfolio.accountLen), 2, 19);
    expect(isPortfolioAccount(shortV22)).toBe(false); // v2.2 stamp at the v2.1 length is not whole
  });
});

describe("negative control for this suite", () => {
  it("a flipped expectation fails: the v2.2 length is not the v2.1 length", () => {
    __setDevnetV22ForTest(true);
    expect(() => expect(portfolioAccountLen()).toBe(9563)).toThrow();
  });
});
