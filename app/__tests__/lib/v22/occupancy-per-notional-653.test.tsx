/**
 * prog#653 (#572 per notional, rc23 178fedc4): one holding-fee rate per side, `max(utilisation, occupancy)`. The numbers
 * marked "real crate" are rows of the percolator-sdk#443 fixture (`rent_occupancy_rate_e9`, `rent_side_rate_e9`, offset_of!).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readBandRentView } from "@/lib/v22/band-rent-state";
import { HoldingFeeChip, holdingFeeLabel } from "@/components/v22/HoldingFeeChip";
import { OpenModeMarketNotes } from "@/components/v22/OpenModeMarketNotes";
import { V22_COPY } from "@/lib/v22/copy";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, rentOccupancyRateE9V22, rentSideRateE9V22 } from "@/lib/v22/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";

const L = LAYOUT_V22;
const B = L.bandRent!;
const put64 = (d: Uint8Array, o: number, x: bigint) => new DataView(d.buffer).setBigUint64(o, x, true);

function bandMarket(o: { nLong?: bigint; nShort?: bigint; rentMax?: bigint; band?: number; growth?: number; bound?: boolean; nCap?: bigint; oiLong?: bigint }): Uint8Array {
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  const cfg = L.marketGroupOff + L.group.config;
  put64(d, cfg + B.config.bandBps, BigInt(o.band ?? 130));
  put64(d, cfg + B.config.rentMaxE9PerSlot, o.rentMax ?? 1000n);
  put64(d, cfg + B.config.bandMaxPositionsPerSide, 256n);
  put64(d, cfg + B.config.maxPriceMoveBpsPerSlot, 4n);
  put64(d, cfg + B.config.maxAccrualDtSlots, 100n);
  const slot = L.marketGroupOff + L.marketGroupLen;
  const eng = slot + L.wrapperSlotLen;
  put64(d, eng + L.assetState.effectivePrice, 50_000_000n);
  put64(d, eng + L.assetState.rawOracleTargetPrice, 50_000_000n);
  put64(d, eng + L.assetState.oiEffLongQ, o.oiLong ?? 0n);
  put64(d, eng + B.assetState.storedPosCountLong, o.nLong ?? 0n);
  put64(d, eng + B.assetState.storedPosCountShort, o.nShort ?? 0n);
  d[slot + L.wrapperSlot.growth + B.growth.version] = o.growth ?? 1;
  put64(d, slot + L.wrapperSlot.growth + B.growth.rentNCapQ, o.nCap ?? 1_000_000n);
  new DataView(d.buffer).setUint16(slot + L.wrapperSlot.growth + B.growth.rentKinkBps, 5000, true);
  d[slot + L.wrapperSlot.vaultLp + B.vaultLp.flags] = o.bound === false ? 0 : 1;
  return d;
}

describe("prog#653 one per-notional rate", () => {
  it("vendored offsets and ramp == real crate", () => {
    expect([B.assetState.storedPosCountLong, B.assetState.storedPosCountShort, B.growth.version]).toEqual([321, 329, 38]);
    expect(rentOccupancyRateE9V22(217n, 256n, 10_000n)).toBe(0n);
    expect(rentOccupancyRateE9V22(218n, 256n, 10_000n)).toBe(2n);
    expect(rentOccupancyRateE9V22(256n, 256n, 10_000n)).toBe(10_000n);
    expect(rentSideRateE9V22(0n, 1_000n, 5_000, 100n, 256n, 256n)).toBe(100n);
    expect(rentSideRateE9V22(900n, 1_000n, 5_000, 100n, 217n, 256n)).toBe(80n);
  });
  it("a nearly full side shows the occupancy rate, per side, and nothing changes at or below 85%", () => {
    const v = readBandRentView(bandMarket({ nLong: 217n, nShort: 256n }))!;
    expect(v.rent.rateLongE9).toBe(0n);
    expect(v.rent.rateShortE9).toBe(1000n);
    expect(holdingFeeLabel(v, "short")).toBe("Holding fee 21.60% per day");
    expect(holdingFeeLabel(v, "long")).toBe("No holding fee");
  });
  it("the higher of the two terms, never their sum", () => {
    // utilisation: 900 of 1000, kink 50% -> 80% of max; occupancy at 230 / 256 -> below that
    const v = readBandRentView(bandMarket({ nCap: 1000n, oiLong: 900n, nLong: 230n }))!;
    expect(v.rent.rateLongE9).toBe(800n);
  });
  it("same gates as the program: no growth record, no vault, no N_cap, no band", () => {
    expect(readBandRentView(bandMarket({ nShort: 256n, growth: 0 }))!.rent.rateShortE9).toBe(0n);
    expect(readBandRentView(bandMarket({ nShort: 256n, bound: false }))!.rent.rateShortE9).toBe(0n);
    expect(readBandRentView(bandMarket({ nShort: 256n, nCap: 0n }))!.rent.rateShortE9).toBe(0n);
    expect(readBandRentView(bandMarket({ nShort: 256n, band: 0 }))!.rent.rateShortE9).toBe(0n);
  });
  it("chip and open-mode notes show one rate; the hint says it rises when nearly full; no flat per-position wording", () => {
    const v = readBandRentView(bandMarket({ nShort: 256n }));
    render(<HoldingFeeChip view={v} side="short" />);
    expect(screen.getByTestId("holding-fee").textContent).toBe("Holding fee 21.60% per day");
    expect(screen.getByTestId("holding-fee").getAttribute("title")).toBe(V22_COPY.rent.hint);
    render(<OpenModeMarketNotes lotGuard={null} view={v} side="short" collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("holding-fee-open").textContent).toBe("Holding fee 21.60% per day");
    expect(V22_COPY.rent.hint).toContain("The holding fee rises when the market is nearly full.");
    expect(V22_COPY.wizard.holdingFeeHint).toContain("rises when the market is nearly full");
    expect(readFileSync(path.join(process.cwd(), "lib/v22/copy.ts"), "utf8")).not.toMatch(/per position/);
  });
});
