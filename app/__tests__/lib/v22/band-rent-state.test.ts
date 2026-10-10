/**
 * v2.2 band + holding-fee read model (lib/v22/band-rent-state.ts). The offsets are derived from the engine structs;
 * the first block pins them against the SDK layout row so a layout change fails here instead of misreading.
 */
import { describe, expect, it } from "vitest";
import {
  closeBlockedByBand,
  legBelowHalfMin,
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
