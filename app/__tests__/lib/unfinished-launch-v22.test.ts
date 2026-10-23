/**
 * #3606: /my-markets reads what an unfinished v2.2 launch had completed from the market's own bytes.
 *
 * `readLaunchFootprint` used the installed SDK 8.0.0 `parseBackingBucketsV17`, which accepts wrapper VERSION 18 only, so on every
 * v2.2 (VERSION 19) market it threw, the footprint was null, and the row stayed on "Reading what this launch had completed…" forever.
 * These tests run on the CAPTURED v2.2 one-slot SOL market (4,059 B, VERSION 19), not hand-built bytes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V22 } from "@/lib/v22/sdk/layout";
import { parseBackingBucketsV17 as v22ParseBuckets } from "@/lib/v22/sdk/records/backing-bucket";
import { marketGeometry, parseMarketOI, isWrapperMarketAccount } from "@/lib/v22/layout";
import { readV17AssetSlotLast } from "@/lib/v17-engine-clock";
import { readMarketGroupHeader } from "@/lib/v18-wire";
import { classifyLaunchStage, readLaunchFootprint, unfinishedStageCopy, UNFINISHED_COPY } from "@/lib/unfinished-launch";
import { parseWrapperConfigV17 as installedParseWrapperConfig } from "@percolatorct/sdk";
import { parseWrapperConfigV17 as v22ParseWrapperConfig } from "@/lib/v22/sdk/slab";
import { v22MarketBytes } from "../helpers/v22-fixtures";
import { liveSlab, FINISHED_SLAB, UNFINISHED_SLAB } from "../fixtures/relaunch/m7-slabs";

const BUCKET_LEN = 97;
afterEach(() => __setDevnetV22ForTest(null));

/** Absolute offsets (from the v2.2 layout table) of every backing bucket of a v2.2 market, plus the header fields the footprint reads. */
function v22Offsets(d: Uint8Array) {
  const geo = marketGeometry(d);
  const g = geo.groupOff;
  const buckets: number[] = [];
  for (let i = 0; i < geo.slotCount; i++) buckets.push(geo.engineOff(i) + LAYOUT_V22.engineSlot.backingLong, geo.engineOff(i) + LAYOUT_V22.engineSlot.backingShort);
  return { cTot: g + LAYOUT_V22.group.cTot, portfolios: g + LAYOUT_V22.group.materializedPortfolioCount, buckets };
}

/** The captured market with c_tot, the portfolio count and every backing bucket zeroed: a launch stopped before its LP step. */
function v22NothingDone(): Uint8Array {
  const d = v22MarketBytes();
  const o = v22Offsets(d);
  d.fill(0, o.cTot, o.cTot + 16);
  d.fill(0, o.portfolios, o.portfolios + 8);
  for (const b of o.buckets) d.fill(0, b, b + BUCKET_LEN);
  return d;
}

describe("v2.2 flag ON: the footprint decodes VERSION 19 bytes", () => {
  it("the captured v2.2 market is VERSION 19 and the installed decoder path is what failed on it", () => {
    __setDevnetV22ForTest(true);
    const d = v22MarketBytes();
    expect(d.length).toBe(4059);
    expect(new DataView(d.buffer).getUint16(8, true)).toBe(19);
  });

  it("reads the captured market (not null), field-for-field equal to the vendored v2.2 decoders", () => {
    __setDevnetV22ForTest(true);
    const d = v22MarketBytes();
    const f = readLaunchFootprint(d);
    expect(f).not.toBeNull();
    const h = readMarketGroupHeader(d);
    const b = v22ParseBuckets(d);
    expect(b.buckets.length).toBe(2); // one slot: long + short
    expect(f).toEqual({
      mode: h.mode,
      cTot: h.cTot,
      portfolios: h.materializedPortfolioCount,
      backingFunded: b.buckets.some((x) => x.status !== 0 || x.freshUnlienedBackingNum > 0n || x.validLienedBackingNum > 0n || x.consumedLienedBackingNum > 0n || x.impairedLienedBackingNum > 0n || x.utilizationFeeEarnings > 0n),
    });
    // a seeded, live market: the panel says it is committed, never "Reading…"
    const stage = classifyLaunchStage(f, 0n);
    expect(stage.kind).toBe("committed");
    expect(unfinishedStageCopy(stage)).not.toBe(UNFINISHED_COPY.unknown);
  });

  it("a v2.2 launch that stopped before its LP step is removable (buckets read at the v2.2 offsets, all empty)", () => {
    __setDevnetV22ForTest(true);
    const d = v22NothingDone();
    const f = readLaunchFootprint(d);
    expect(f).toMatchObject({ cTot: 0n, portfolios: 0n, backingFunded: false });
    expect(classifyLaunchStage(f, 0n)).toEqual({ kind: "removable" });
  });

  it("v2.2 LP-vault backing alone (c_tot and portfolios zero) is committed + funded: the reclaim is hidden", () => {
    __setDevnetV22ForTest(true);
    const d = v22NothingDone();
    const o = v22Offsets(d);
    // fresh_unliened_backing_num (u128 @ +8) of the SHORT bucket of slot 0
    new DataView(d.buffer).setBigUint64(o.buckets[1] + 8, 5n, true);
    const f = readLaunchFootprint(d);
    expect(f).toMatchObject({ cTot: 0n, portfolios: 0n, backingFunded: true });
    expect(classifyLaunchStage(f, 0n)).toEqual({ kind: "committed", funded: true });
  });

  it("the rest of the /my-markets enrichment for the row (OI, engine clock) also reads v2.2 bytes", () => {
    __setDevnetV22ForTest(true);
    const d = v22MarketBytes();
    expect(isWrapperMarketAccount(d)).toBe(true);
    expect(() => parseMarketOI(d)).not.toThrow();
    expect(() => readV17AssetSlotLast(d)).not.toThrow();
  });

  it("the close path's installed-SDK wrapper-config read (no VERSION gate) agrees with the v2.2 port on v2.2 bytes", () => {
    __setDevnetV22ForTest(true);
    const d = v22MarketBytes();
    const a = installedParseWrapperConfig(d);
    const b = v22ParseWrapperConfig(d);
    expect(a.marketauth.toBase58()).toBe(b.marketauth.toBase58());
    expect(a.collateralMint.toBase58()).toBe(b.collateralMint.toBase58());
  });

  it("v2.1 (VERSION 18) slabs read the same with the flag on as off", () => {
    for (const s of [FINISHED_SLAB, UNFINISHED_SLAB]) {
      __setDevnetV22ForTest(false);
      const off = readLaunchFootprint(new Uint8Array(liveSlab(s)));
      __setDevnetV22ForTest(true);
      const on = readLaunchFootprint(new Uint8Array(liveSlab(s)));
      expect(off).not.toBeNull();
      expect(on).toEqual(off);
    }
  });
});

describe("v2.2 flag OFF: unchanged", () => {
  it("v2.1 slabs read exactly as before", () => {
    __setDevnetV22ForTest(false);
    expect(readLaunchFootprint(new Uint8Array(liveSlab(FINISHED_SLAB)))).toMatchObject({ mode: 0, cTot: 1_000_000_000n, portfolios: 1n, backingFunded: true });
    expect(readLaunchFootprint(new Uint8Array(liveSlab(UNFINISHED_SLAB)))).toMatchObject({ cTot: 0n, backingFunded: false });
  });
  it("VERSION 19 bytes are not decoded with the flag off (null, as before: the off build knows no v2.2 layout)", () => {
    __setDevnetV22ForTest(false);
    expect(readLaunchFootprint(v22MarketBytes())).toBeNull();
  });
});
