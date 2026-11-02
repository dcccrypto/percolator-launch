/**
 * prog#572 (#647, rc23 34996503): on a band market every position on a side more than 85% full also pays a flat amount
 * per slot (the same for every position), on top of the per-notional holding fee. Read through the vendored SDK port
 * (percolator-sdk#441, whose real-crate fixture pins the math); the values marked "real crate" are rows of that fixture.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readBandRentView, occupancyAtomsPerDay, type BandRentView } from "@/lib/v22/band-rent-state";
import { holdingFeeLabel, HoldingFeeChip, flatFeeText } from "@/components/v22/HoldingFeeChip";
import { OpenModeMarketNotes } from "@/components/v22/OpenModeMarketNotes";
import { V22_COPY } from "@/lib/v22/copy";
import {
  ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, occRampQ32V22, occupancyDueV22, occCkEncodeV22, v22Slab,
} from "@/lib/v22/sdk";

const L = LAYOUT_V22;
const B = L.bandRent!;
const put64 = (d: Uint8Array, o: number, x: bigint) => new DataView(d.buffer).setBigUint64(o, x, true);

function bandMarket(o: { nLong?: bigint; nShort?: bigint; bound?: boolean; mode?: number; rentMax?: bigint; minLeg?: bigint; band?: number }): Uint8Array {
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  const cfg = L.marketGroupOff + L.group.config;
  put64(d, cfg + B.config.bandBps, BigInt(o.band ?? 130));
  put64(d, cfg + B.config.rentMaxE9PerSlot, o.rentMax ?? 100n);
  put64(d, cfg + B.config.bandMaxPositionsPerSide, 256n);
  put64(d, cfg + B.config.bandMinLegNotional, o.minLeg ?? 10_000_000n);
  put64(d, cfg + B.config.maxPriceMoveBpsPerSlot, 4n);
  put64(d, cfg + B.config.maxAccrualDtSlots, 100n);
  d[L.marketGroupOff + L.group.mode] = o.mode ?? 0;
  const slot = L.marketGroupOff + L.marketGroupLen;
  const eng = slot + L.wrapperSlotLen;
  put64(d, eng + L.assetState.effectivePrice, 50_000_000n);
  put64(d, eng + L.assetState.rawOracleTargetPrice, 50_000_000n);
  put64(d, eng + B.occupancy.storedPosCountLong, o.nLong ?? 0n);
  put64(d, eng + B.occupancy.storedPosCountShort, o.nShort ?? 0n);
  d[slot + L.wrapperSlot.vaultLp + B.vaultLp.flags] = o.bound === false ? 0 : 1;
  return d;
}
const USDC = { decimals: 6, symbol: "USDC" };

describe("prog#572 occupancy in the band / rent view", () => {
  it("vendored offsets == real crate (rustc offset_of! / state::OCC_PROFILE_BYTES at prog 34996503, sdk#441 fixture)", () => {
    expect(B.occupancy).toEqual({ storedPosCountLong: 321, storedPosCountShort: 329, slotLast: 41, profileClockSlot: 408, profileClockLong: 416, profileClockShort: 424, vaultLpPortfolio: 0, portfolioLastFeeSlot: 324 });
  });
  it("vendored port == real crate rows (occ_ramp_q32 at cap 256)", () => {
    expect(occRampQ32V22(217n, 256n)).toBe(0n);
    expect(occRampQ32V22(218n, 256n)).toBe(466_034n);
    expect(occRampQ32V22(230n, 256n)).toBe(447_858_461n);
    expect(occRampQ32V22(255n, 256n)).toBe(4_074_183_794n);
    expect(occRampQ32V22(256n, 256n)).toBe(1n << 32n);
    // real crate scenario knee_then_full @1500: a long checkpoint at clock 0, clock 1100 -> 1500 at 230 / 256 -> 164 atoms
    const p = { cap: 256n, fullNum: 4_000_000_000n, lpBound: true, countLong: 230n, countShort: 256n };
    expect(occupancyDueV22(occCkEncodeV22(0n, false), "long", { lastSlot: 1100n, longQ32: 0n, shortQ32: 0n }, p, 1500n).due).toBe(164n);
  });
  it("seed market (rent_max 100, min leg 10 USDC): a full side pays 4 atoms per slot per position = 0.864 USDC per day", () => {
    const v = readBandRentView(bandMarket({ nLong: 217n, nShort: 256n }))!;
    expect(v.occupancy).toEqual({ enabled: true, perPositionLongE9: 0n, perPositionShortE9: 4_000_000_000n, countLong: 217n, countShort: 256n, cap: 256n });
    expect(occupancyAtomsPerDay(v, "short")).toBe(864_000n);
    expect(occupancyAtomsPerDay(v, "long")).toBe(0n);
  });
  it("off while not Live, with no vault LP, rent off, or off the band", () => {
    expect(readBandRentView(bandMarket({ nShort: 256n, mode: 1 }))!.occupancy!.enabled).toBe(false);
    expect(occupancyAtomsPerDay(readBandRentView(bandMarket({ nShort: 256n, bound: false })), "short")).toBe(0n);
    expect(readBandRentView(bandMarket({ nShort: 256n, rentMax: 0n }))!.occupancy!.enabled).toBe(false);
    const noBand = readBandRentView(bandMarket({ band: 0, nShort: 256n }))!;
    expect(noBand.occupancy).toBeUndefined();
    expect(occupancyAtomsPerDay(noBand, "short")).toBe(0n);
  });
  it("parsePortfolioV17 reads a band market's tagged last_fee_slot as a checkpoint, not a slot", () => {
    const d = new Uint8Array(L.portfolio.accountLen);
    const v = new DataView(d.buffer);
    v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
    v.setUint16(8, L.version, true);
    d[10] = ACCOUNT_KIND.Portfolio;
    v.setUint16(112, 1, true);
    v.setUint16(114, L.engineDiscriminator, true);
    put64(d, 16 + B.occupancy.portfolioLastFeeSlot, occCkEncodeV22(77n, false));
    expect(v22Slab.parsePortfolioV17(d).occupancyCheckpoint).toEqual({ short: false, clockInt: 77n });
    put64(d, 16 + B.occupancy.portfolioLastFeeSlot, 312_000_000n); // a real slot (non-band market)
    expect(v22Slab.parsePortfolioV17(d).occupancyCheckpoint).toBeNull();
  });
});

describe("holding-fee label and chip with the flat part", () => {
  const withOcc = (rateLongE9: bigint, perPositionLongE9: bigint): BandRentView => ({
    assetIndex: 0, lotExp: 0,
    band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 10_000_000n, recoveryMinutes: 64 },
    price: { capBpsPerSlot: 4n, markE6: 50_000_000n, targetE6: 50_000_000n, lagging: false, floorStuck: false, favourableCloseSide: null },
    rent: { enabled: true, maxE9PerSlot: 100n, kinkBps: 5000, rateLongE9, rateShortE9: 0n },
    occupancy: { enabled: true, perPositionLongE9, perPositionShortE9: 0n, countLong: 256n, countShort: 0n, cap: 256n },
  });
  it("adds the flat part past 85%, rounded up to the cent", () => {
    expect(holdingFeeLabel(withOcc(10n, 4_000_000_000n), "long", USDC)).toBe("Holding fee 0.22% + 0.87 USDC per day");
    expect(holdingFeeLabel(withOcc(0n, 4_000_000_000n), "long", USDC)).toBe("Holding fee 0.87 USDC per day per position");
  });
  it("unchanged at or below 85%, on the other side, or without the collateral", () => {
    expect(holdingFeeLabel(withOcc(10n, 0n), "long", USDC)).toBe("Holding fee 0.22% per day");
    expect(holdingFeeLabel(withOcc(0n, 0n), "long", USDC)).toBe("No holding fee");
    expect(holdingFeeLabel(withOcc(0n, 4_000_000_000n), "short", USDC)).toBe("No holding fee");
    expect(holdingFeeLabel(withOcc(10n, 4_000_000_000n), "long")).toBe("Holding fee 0.22% per day");
  });
  it("tiny amounts read <0.01", () => {
    expect(flatFeeText(9_999n, USDC)).toBe("<0.01 USDC");
    expect(flatFeeText(10_000n, USDC)).toBe("0.01 USDC");
    expect(flatFeeText(10_001n, USDC)).toBe("0.02 USDC");
  });
  it("chip and open-mode notes show it; the hint explains the 85% rule in plain words", () => {
    render(<HoldingFeeChip view={withOcc(10n, 4_000_000_000n)} side="long" collateral={USDC} />);
    expect(screen.getByTestId("holding-fee").textContent).toBe("Holding fee 0.22% + 0.87 USDC per day");
    expect(screen.getByTestId("holding-fee").getAttribute("title")).toBe(V22_COPY.rent.hint);
    render(<OpenModeMarketNotes lotGuard={null} view={withOcc(0n, 4_000_000_000n)} side="long" collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("holding-fee-open").textContent).toBe("Holding fee 0.87 USDC per day per position");
    expect(V22_COPY.rent.hint).toContain("more than 85% full");
    expect(V22_COPY.rent.hint).toContain("same small flat amount per day");
  });
});
