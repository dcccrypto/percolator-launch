/**
 * v2.2 band + holding-fee read model (lib/v22/band-rent-state.ts). The offsets are derived from the engine structs;
 * the first block pins them against the SDK layout row so a layout change fails here instead of misreading.
 */
import { describe, expect, it } from "vitest";
import {
  bandCatchUpMs,
  bandMinLeg,
  bandMinLegExactQ,
  closeBlockedByBand,
  legBelowBandMin,
  legBelowHalfMin,
  minNotionalUnitsUp,
  orderBlockedByBand,
  type BandRentView,
  readBandRentView,
  rentPercentPerDay,
  rentRateE9,
  usersSideOi,
} from "@/lib/v22/band-rent-state";
import { LAYOUT_V21, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

const L = LAYOUT_V22;
const B = L.bandRent!; // the SDK candidate's band/rent offsets (no app-derived copy any more)

function market(layout = L, slots = 1): Uint8Array {
  const len = layout.marketGroupOff + layout.marketGroupLen + slots * layout.assetSlotStride;
  const d = new Uint8Array(len);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, layout.version, true);
  d[10] = ACCOUNT_KIND.Market;
  return d;
}
const put64 = (d: Uint8Array, o: number, x: bigint) => new DataView(d.buffer).setBigUint64(o, x, true);
const put16 = (d: Uint8Array, o: number, x: number) => new DataView(d.buffer).setUint16(o, x, true);
function putI128(d: Uint8Array, o: number, x: bigint) {
  const v = new DataView(d.buffer);
  v.setBigUint64(o, BigInt.asUintN(64, x), true);
  v.setBigInt64(o + 8, x >> 64n, true);
}

interface Opts { maxStepBps?: number; maxDt?: number; pinSince?: bigint; bandBps?: number; epoch?: number; pin?: number; rentMax?: number; minLeg?: bigint; mark?: bigint; target?: bigint; lotExp?: number; kink?: number; nCap?: bigint; bound?: boolean; lpNet?: bigint; oiLong?: bigint; oiShort?: bigint }
function build(o: Opts): Uint8Array {
  const d = market();
  const cfg = L.marketGroupOff + L.group.config;
  put64(d, cfg + B.config.bandBps, BigInt(o.bandBps ?? 0));
  put64(d, cfg + B.config.bandMaxEpochSlots, BigInt(o.epoch ?? 600));
  put64(d, cfg + B.config.bandMaxPinSlots, BigInt(o.pin ?? 9000));
  put64(d, cfg + B.config.rentMaxE9PerSlot, BigInt(o.rentMax ?? 0));
  put64(d, cfg + B.config.bandMinLegNotional, o.minLeg ?? 0n);
  put64(d, cfg + B.config.maxPriceMoveBpsPerSlot, BigInt(o.maxStepBps ?? 4));
  put64(d, cfg + B.config.maxAccrualDtSlots, BigInt(o.maxDt ?? 100));
  const slot = L.marketGroupOff + L.marketGroupLen;
  const eng = slot + L.wrapperSlotLen;
  put64(d, eng + L.assetState.effectivePrice, o.mark ?? 50_000_000n);
  put64(d, eng + L.assetState.rawOracleTargetPrice, o.target ?? 50_000_000n);
  put64(d, eng + B.assetState.bandPinSinceSlot, o.pinSince ?? 0n);
  putI128(d, eng + L.assetState.oiEffLongQ, o.oiLong ?? 1_000_000n);
  putI128(d, eng + L.assetState.oiEffShortQ, o.oiShort ?? 0n);
  d[slot + L.wrapperSlot.profileLotExp] = o.lotExp ?? 0;
  put16(d, slot + L.wrapperSlot.growth + 42, o.kink ?? 5000);
  put64(d, slot + L.wrapperSlot.growth + 48, o.nCap ?? 0n);
  d[slot + L.wrapperSlot.vaultLp + 90] = o.bound ? 1 : 0;
  putI128(d, slot + L.wrapperSlot.vaultLp + 32, o.lpNet ?? 0n);
  return d;
}

describe("the SDK layout row carries the band / rent offsets", () => {
  it("v2.2 has them (config 297 B = assetSlotCapacity - config), v2.1 has none", () => {
    expect(B.configLen).toBe(L.group.assetSlotCapacity - L.group.config);
    expect(LAYOUT_V21.bandRent).toBeNull();
  });
  it("the asset-state words end at the v2.2 asset-state length and start at the v2.1 one", () => {
    expect(B.assetState.rentUnroutedAtoms + 16).toBe(L.assetStateLen);
    expect(B.assetState.bandAnchorPrice).toBe(LAYOUT_V21.assetStateLen);
  });
});

describe("readBandRentView", () => {
  it("SDK lag predicate: a mark != target with ZERO open interest on both sides is NOT lagging (no warning, close not blocked)", () => {
    const v = readBandRentView(build({ bandBps: 130, mark: 60_000_000n, target: 50_000_000n, oiLong: 0n, oiShort: 0n }))!;
    expect(v.price.lagging).toBe(false);
    expect(v.price.favourableCloseSide).toBeNull();
    expect(closeBlockedByBand(v, "long")).toBe(false);
    // exposure on EITHER side makes it lag
    expect(readBandRentView(build({ bandBps: 130, mark: 60_000_000n, target: 50_000_000n, oiLong: 0n, oiShort: 5n }))!.price.lagging).toBe(true);
  });
  it("a band market: lagging mark vs target, favourable close side, minimum position, recovery minutes", () => {
    const v = readBandRentView(build({ bandBps: 130, minLeg: 100_000_000n, mark: 60_000_000n, target: 50_000_000n, lotExp: 3 }))!;
    expect(v.band.enabled).toBe(true);
    expect(v.band.minLegNotionalAtoms).toBe(100_000_000n);
    expect(v.band.recoveryMinutes).toBeGreaterThan(60); // (600 + 9000) * 0.4 s / 60 = 64
    expect(v.lotExp).toBe(3);
    expect(v.price).toMatchObject({ markE6: 60_000_000n, targetE6: 50_000_000n, lagging: true, favourableCloseSide: "long" });
    // mark below target (price rose): shorts exit favourably
    expect(readBandRentView(build({ bandBps: 130, mark: 40_000_000n, target: 50_000_000n }))!.price.favourableCloseSide).toBe("short");
  });
  it("mark equals target: not lagging, no blocked side", () => {
    const v = readBandRentView(build({ bandBps: 130 }))!;
    expect(v.price.lagging).toBe(false);
    expect(v.price.favourableCloseSide).toBeNull();
    expect(closeBlockedByBand(v, "long")).toBe(false);
  });
  it("only the favourable side's close is blocked, only while lagging", () => {
    const v = readBandRentView(build({ bandBps: 130, mark: 60_000_000n, target: 50_000_000n }))!;
    expect(closeBlockedByBand(v, "long")).toBe(true);
    expect(closeBlockedByBand(v, "short")).toBe(false);
    expect(closeBlockedByBand(null, "long")).toBe(false);
  });
  it("a market with neither band nor rent, a v2.1 market, and unknown VERSION give null (never numbers)", () => {
    expect(readBandRentView(build({}))).toBeNull();
    expect(readBandRentView(market(LAYOUT_V21))).toBeNull();
    const d = build({ bandBps: 130 });
    new DataView(d.buffer).setUint16(8, 20, true);
    expect(readBandRentView(d)).toBeNull();
    expect(readBandRentView(null)).toBeNull();
    expect(readBandRentView(new Uint8Array(10))).toBeNull();
  });
  it("rent market: current rate from users OI (vault LP leg excluded), kink and N_cap", () => {
    // N_cap 1000, kink 50%. The vault LP is long 250, so users long = 1000 - 250 = 750 (u = 75%) -> half of max.
    // Users short = 100 (the LP is not on that side) -> u = 10%, below the kink -> 0.
    const bytes = build({ rentMax: 1000, kink: 5000, nCap: 1000n, bound: true, lpNet: 250n, oiLong: 1000n, oiShort: 100n });
    const v = readBandRentView(bytes)!;
    expect(v.rent.enabled).toBe(true);
    expect(v.rent.rateLongE9).toBe(500n);
    expect(v.rent.rateShortE9).toBe(0n);
    // Not bound (or N_cap not measured yet): the wrapper charges nothing, so the view says 0 rather than guessing.
    expect(readBandRentView(build({ rentMax: 1000, kink: 5000, nCap: 1000n, bound: false, lpNet: 250n, oiLong: 1000n }))!.rent.rateLongE9).toBe(0n);
    expect(readBandRentView(build({ rentMax: 1000, kink: 5000, nCap: 0n, bound: true, oiLong: 1000n }))!.rent.rateLongE9).toBe(0n);
  });
});

describe("rentRateE9 (port of growth_v19::rent_rate_e9)", () => {
  it("0 at or below the kink, max at full utilisation, ceil in between", () => {
    expect(rentRateE9(500n, 1000n, 5000, 1000n)).toBe(0n);
    expect(rentRateE9(750n, 1000n, 5000, 1000n)).toBe(500n);
    expect(rentRateE9(1000n, 1000n, 5000, 1000n)).toBe(1000n);
    expect(rentRateE9(751n, 1000n, 5000, 1000n)).toBe(502n); // ceil(1000 * 251 / 500) = 502
  });
  it("fails closed to the ceiling on a zero N_cap or a kink above 100%", () => {
    expect(rentRateE9(1n, 0n, 5000, 1000n)).toBe(1000n);
    expect(rentRateE9(1n, 10n, 10_001, 1000n)).toBe(1000n);
  });
  it("users OI excludes the vault LP's own leg", () => {
    expect(usersSideOi(500n, 200n, true)).toBe(300n);
    expect(usersSideOi(500n, 200n, false)).toBe(500n);
    expect(usersSideOi(100n, -400n, false)).toBe(0n);
  });
  it("percent per day uses 216,000 slots a day", () => {
    expect(rentPercentPerDay(10_000n)).toBeCloseTo(216, 6);
    expect(rentPercentPerDay(0n)).toBe(0);
  });
});

describe("legBelowHalfMin", () => {
  it("a leg under half the market minimum can be closed by anyone", () => {
    // 6-decimal collateral, min 100 tokens = 100_000_000 atoms; leg of 40 lots at $1 = $40 < $50
    expect(legBelowHalfMin(40_000_000n, 1_000_000n, 100_000_000n)).toBe(true);
    expect(legBelowHalfMin(60_000_000n, 1_000_000n, 100_000_000n)).toBe(false);
    expect(legBelowHalfMin(1n, 1n, 0n)).toBe(false);
  });
});


describe("F8: no decimals scaling (engine band_leg_is_dust compares q*price/POS_SCALE raw)", () => {
  it("the verdict does not depend on collateral decimals", () => {
    // 40 lots at $1: notional 40_000_000 raw; half-min = 50_000_000 -> dust. With a 9-decimal scaling it would read 1000x bigger.
    expect(legBelowHalfMin(40_000_000n, 1_000_000n, 100_000_000n)).toBe(true);
    expect(legBelowHalfMin.length).toBe(3); // no decimals parameter any more
  });
});

describe("F7: the wrapper's floor-stuck exemption", () => {
  const lag = { bandBps: 130, mark: 60_000_000n, target: 50_000_000n };
  it("normal lag: long close blocked, floorStuck false", () => {
    const v = readBandRentView(build(lag))!;
    expect(v.price.floorStuck).toBe(false);
    expect(closeBlockedByBand(v, "long")).toBe(true);
  });
  it("cap dead zone (max step 0): not blocked, the chain would accept the close", () => {
    const v = readBandRentView(build({ ...lag, maxStepBps: 0 }))!;
    expect(v.price.floorStuck).toBe(true);
    expect(closeBlockedByBand(v, "long")).toBe(false);
  });
  it("pin clock running AND band too narrow at the mark: not blocked; pin running but band wide: still blocked", () => {
    const narrow = readBandRentView(build({ bandBps: 130, mark: 1_000n, target: 500n, pinSince: 5n }))!;
    expect(narrow.price.floorStuck).toBe(true);
    expect(closeBlockedByBand(narrow, "long")).toBe(false);
    const wide = readBandRentView(build({ ...lag, pinSince: 5n }))!;
    expect(wide.price.floorStuck).toBe(false);
    expect(closeBlockedByBand(wide, "long")).toBe(true);
    // narrow band but pin clock NOT running: refusal is not lifted
    expect(closeBlockedByBand(readBandRentView(build({ bandBps: 130, mark: 1_000n, target: 500n, pinSince: 0n }))!, "long")).toBe(true);
  });
  it("any mark/target difference counts as lag (wrapper has no target != 0 condition)", () => {
    const v = readBandRentView(build({ bandBps: 130, mark: 60_000_000n, target: 0n }))!;
    expect(v.price.lagging).toBe(true);
  });
});

// Hand-written views (not produced by readBandRentView) so the pure helpers are tested against their documented rules.
function view(o: { enabled?: boolean; lagging?: boolean; floorStuck?: boolean; side?: "long" | "short" | null; lotExp?: number; mark?: bigint; target?: bigint; cap?: bigint; bandBps?: number; minLeg?: bigint } = {}): BandRentView {
  return {
    assetIndex: 0,
    lotExp: o.lotExp ?? 3,
    band: { enabled: o.enabled ?? true, bandBps: o.bandBps ?? 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 10n, minLegNotionalAtoms: o.minLeg ?? 100_000_000n, recoveryMinutes: 64 },
    price: { capBpsPerSlot: o.cap ?? 4n, markE6: o.mark ?? 32_120_000n, targetE6: o.target ?? 32_120_000n, lagging: o.lagging ?? false, floorStuck: o.floorStuck ?? false, favourableCloseSide: o.side ?? null },
    rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 5000, rateLongE9: 0n, rateShortE9: 0n },
  };
}

describe("bandCatchUpMs", () => {
  // mark 60, target 50 (per lot e6): gap = ceil(10/60 * 10_000) = 1667 bps. Sweep = 26 slots.
  const lag = { lagging: true, mark: 60_000_000n, target: 50_000_000n };
  it("null without a view, on a market without a band, or while not lagging", () => {
    expect(bandCatchUpMs(null)).toBeNull();
    expect(bandCatchUpMs(view({ ...lag, enabled: false }))).toBeNull();
    expect(bandCatchUpMs(view({ ...lag, lagging: false }))).toBeNull();
  });
  it("cap 4 bps/slot x 26 = 104 bps per sweep (band 130 is wider): ceil(1667/104)=17 sweeps = 442 slots = 176.8 s", () => {
    expect(bandCatchUpMs(view(lag))).toBe(176_800);
  });
  it("a narrower band (50 bps) limits the step: 34 sweeps = 884 slots", () => {
    expect(bandCatchUpMs(view({ ...lag, bandBps: 50 }))).toBe(353_600);
  });
  it("slotMs scales the answer", () => {
    expect(bandCatchUpMs(view(lag), 1000)).toBe(442_000);
  });
  it("null when there is no estimate (cap 0) or the walk needs no time (mark == target)", () => {
    expect(bandCatchUpMs(view({ ...lag, cap: 0n }))).toBeNull();
    expect(bandCatchUpMs(view({ lagging: true }))).toBeNull();
  });
});

describe("closeBlockedByBand (hand-built views)", () => {
  it("blocked only for lagging + not floor-stuck + matching favourable side", () => {
    expect(closeBlockedByBand(view({ lagging: true, side: "short" }), "short")).toBe(true);
    expect(closeBlockedByBand(view({ lagging: true, side: "short" }), "long")).toBe(false);
    expect(closeBlockedByBand(view({ lagging: true, floorStuck: true, side: "short" }), "short")).toBe(false);
    expect(closeBlockedByBand(view({ lagging: false, side: "short" }), "short")).toBe(false);
  });
});

describe("orderBlockedByBand (#3609: only the reducing part of a fill is refused)", () => {
  const longFav = view({ lagging: true, side: "long" });
  it("flat position: never refused", () => {
    expect(orderBlockedByBand(longFav, 0n, -5n)).toBe(false);
  });
  it("partial close, full close and flip of a long are refused", () => {
    expect(orderBlockedByBand(longFav, 10n, -4n)).toBe(true);
    expect(orderBlockedByBand(longFav, 10n, -10n)).toBe(true);
    expect(orderBlockedByBand(longFav, 10n, -15n)).toBe(true);
  });
  it("growing the position is not refused", () => {
    expect(orderBlockedByBand(longFav, 10n, 5n)).toBe(false);
    expect(orderBlockedByBand(longFav, -10n, -5n)).toBe(false);
  });
  it("the side rule applies: a short being reduced is fine when only longs are blocked, refused when shorts are", () => {
    expect(orderBlockedByBand(longFav, -10n, 4n)).toBe(false);
    expect(orderBlockedByBand(view({ lagging: true, side: "short" }), -10n, 4n)).toBe(true);
    expect(orderBlockedByBand(view({ lagging: true, side: "short" }), -10n, 15n)).toBe(true);
  });
  it("no view: not refused", () => {
    expect(orderBlockedByBand(null, 10n, -10n)).toBe(false);
  });
});

describe("bandMinLeg / bandMinLegExactQ / legBelowBandMin", () => {
  it("null when there is no view, no band, no minimum or no price", () => {
    for (const v of [null, view({ enabled: false }), view({ minLeg: 0n }), view({ mark: 0n })]) {
      expect(bandMinLeg(v)).toBeNull();
      expect(bandMinLegExactQ(v)).toBeNull();
      expect(legBelowBandMin(v, 0n, 1n)).toBe(false);
    }
  });
  it("lotExp > 0: whole lots, min 100 USDC at 32.12 per lot -> 4 lots = 128.48 USDC (the swordcat case)", () => {
    expect(bandMinLeg(view())).toEqual({ lots: 4n, minQ: 4_000_000n, notionalAtoms: 128_480_000n, wholeLots: true });
    // an exact multiple needs no rounding: min 96.36 = 3 lots
    expect(bandMinLeg(view({ minLeg: 96_360_000n }))!.lots).toBe(3n);
  });
  it("lotExp 0: the exact minimum Q, not a whole token ($5,000 token, 100 USDC min -> 0.02 token)", () => {
    expect(bandMinLeg(view({ lotExp: 0, mark: 5_000_000_000n }))).toEqual({ lots: 0n, minQ: 20_000n, notionalAtoms: 100_000_000n, wholeLots: false });
  });
  it("lotExp 0 notional is rounded UP so typing it reaches the minimum", () => {
    // mark 10.003001 -> minQ 9,997,000 (ceil), product 100.0000000003 USDC -> atoms rounded up to 100_000_001
    const m = bandMinLeg(view({ lotExp: 0, mark: 10_003_001n }))!;
    expect(m.minQ).toBe(9_997_000n);
    expect(m.notionalAtoms).toBe((m.minQ * 10_003_001n + 999_999n) / 1_000_000n);
    expect(m.notionalAtoms * 1_000_000n >= m.minQ * 10_003_001n).toBe(true);
  });
  it("exact Q is the smallest q with floor(q*mark/1e6) >= min", () => {
    const v = view();
    const q = bandMinLegExactQ(v)!;
    expect((q * 32_120_000n) / 1_000_000n >= 100_000_000n).toBe(true);
    expect(((q - 1n) * 32_120_000n) / 1_000_000n < 100_000_000n).toBe(true);
  });
  it("legBelowBandMin: under the whole-lot minimum is below, at it is not, full close to zero is fine, either side", () => {
    const v = view(); // minQ 4_000_000
    expect(legBelowBandMin(v, 0n, 3_000_000n)).toBe(true);
    expect(legBelowBandMin(v, 0n, 4_000_000n)).toBe(false);
    expect(legBelowBandMin(v, 0n, -3_000_000n)).toBe(true);
    expect(legBelowBandMin(v, 5_000_000n, -5_000_000n)).toBe(false);
    expect(legBelowBandMin(v, 5_000_000n, -2_000_000n)).toBe(true); // leaves 3 lots
  });
});

describe("minNotionalUnitsUp", () => {
  it("rounds UP to the cent in whole units", () => {
    expect(minNotionalUnitsUp(100_000_000n, 6)).toBe(100);
    expect(minNotionalUnitsUp(100_000_004n, 6)).toBe(100.01);
    expect(minNotionalUnitsUp(128_480_000n, 6)).toBe(128.48);
    expect(minNotionalUnitsUp(1n, 9)).toBe(0.01);
    expect(minNotionalUnitsUp(0n, 6)).toBe(0);
  });
});

describe("readBandRentView: a band market read from bytes feeds the helpers", () => {
  it("catch-up and minimum leg from a SDK-layout fixture", () => {
    const v = readBandRentView(build({ bandBps: 130, minLeg: 100_000_000n, mark: 60_000_000n, target: 50_000_000n, lotExp: 3, maxStepBps: 4 }))!;
    expect(bandCatchUpMs(v)).toBe(176_800);
    expect(bandMinLeg(v)!.lots).toBe(2n); // ceil(100 / 60)
  });
});
