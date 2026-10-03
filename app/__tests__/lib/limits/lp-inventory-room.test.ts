/**
 * LP inventory room from the REAL engine position (matcher-inventory drift, 2026-10-03).
 * Numbers are the live drifted markets from ~/percolator-ops/ledger/matcher-inventory-drift-2026-10-03.md §1/§4.
 */
import { describe, expect, it } from "vitest";
import * as C from "@/lib/limits/constants";
import { ADL_ONE } from "@/lib/limits/constants";
import { lpEffectiveSignedQ, lpInventoryRoomQ, matcherPricingInventoryQ } from "@/lib/limits/lp-inventory-room";
import { SIDE_MODE_RESET_PENDING } from "@/lib/limits/effective-quantity";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { maxTradeSizePerSide } from "@/lib/limits/risk-limits";

const B = 1_000_000_000n;

describe("lpInventoryRoomQ", () => {
  // Gprscv7A: cap 14.03B, counter +14.03B (= +cap), LP really flat (long side reset).
  const cap = 14_025_245_441n;
  const gpr = { counterQ: cap, realQ: 0n, maxInventoryAbs: cap };

  it("PRE-upgrade: min(counter, real) — never offers the stale bypass, never more than the matcher fills", () => {
    const i = { ...gpr, syncLive: false };
    // SELL (taker short, LP buys): the stale counter blocks it on-chain today -> 0, as the matcher will fill.
    expect(lpInventoryRoomQ(i, "short")).toBe(0n);
    // BUY: the counter would admit 2x cap (28.05B); the real position only cap -> cap.
    expect(lpInventoryRoomQ(i, "long")).toBe(cap);
  });

  it("NEGATIVE CONTROL: counter alone (old behaviour) offered the 2x-cap bypass on BUY", () => {
    expect(lpInventoryRoomQ({ ...gpr, realQ: null, syncLive: false }, "long")).toBe(2n * cap);
  });

  it("POST-upgrade: the real position alone — shorts open again (phantom limit gone)", () => {
    const i = { ...gpr, syncLive: true };
    expect(lpInventoryRoomQ(i, "short")).toBe(cap);
    expect(lpInventoryRoomQ(i, "long")).toBe(cap);
  });

  it("5iGg1DPy: counter +378.4B vs real +126.1B, cap 504.5B", () => {
    const i = { counterQ: 378_400n * B / 1000n, realQ: 126_100n * B / 1000n, maxInventoryAbs: 504_500n * B / 1000n };
    expect(lpInventoryRoomQ({ ...i, syncLive: false }, "short")).toBe(126_100n * B / 1000n); // counter binds
    expect(lpInventoryRoomQ({ ...i, syncLive: true }, "short")).toBe(378_400n * B / 1000n);
  });

  it("unknowns: post-upgrade falls back to the counter; nothing known = null", () => {
    expect(lpInventoryRoomQ({ counterQ: 5n, realQ: null, maxInventoryAbs: 10n, syncLive: true }, "long")).toBe(15n);
    expect(lpInventoryRoomQ({ counterQ: null, realQ: null, maxInventoryAbs: 10n, syncLive: false }, "long")).toBeNull();
    expect(lpInventoryRoomQ({ counterQ: null, realQ: -3n, maxInventoryAbs: 10n, syncLive: false }, "long")).toBe(7n);
  });

  it("unlimited caps stay unlimited", () => {
    expect(lpInventoryRoomQ({ counterQ: 1n, realQ: 2n, maxInventoryAbs: 0n, syncLive: false }, "long")).toBe(UNLIMITED_CAPACITY);
  });

  it("matcherPricingInventoryQ reproduces the program, not a min", () => {
    expect(matcherPricingInventoryQ({ counterQ: 9n, realQ: 1n, syncLive: false })).toBe(9n);
    expect(matcherPricingInventoryQ({ counterQ: 9n, realQ: 1n, syncLive: true })).toBe(1n);
    expect(matcherPricingInventoryQ({ counterQ: 9n, realQ: null, syncLive: true })).toBe(9n);
  });
});

describe("lpEffectiveSignedQ (port of 7a3ac04c raw_and_effective_signed_position_for_asset_view .1)", () => {
  const MARKET_ID = 7n;
  const portfolio = (legs: { slot: number; asset: number; marketId: bigint; side: number; basis: bigint; aBasis: bigint; epochSnap: bigint }[]) => {
    const d = new Uint8Array(C.PF_LEGS + C.PF_MAX_LEGS * C.PF_LEG_LEN);
    const v = new DataView(d.buffer);
    for (const l of legs) {
      const o = C.PF_LEGS + l.slot * C.PF_LEG_LEN;
      d[o + C.LEG_ACTIVE] = 1;
      v.setUint32(o + C.LEG_ASSET_INDEX, l.asset, true);
      v.setBigUint64(o + C.LEG_MARKET_ID, l.marketId, true);
      d[o + C.LEG_SIDE] = l.side;
      const u = l.basis < 0n ? (1n << 128n) + l.basis : l.basis;
      v.setBigUint64(o + C.LEG_BASIS_POS_Q, u & ((1n << 64n) - 1n), true);
      v.setBigUint64(o + C.LEG_BASIS_POS_Q + 8, u >> 64n, true);
      v.setBigUint64(o + C.LEG_A_BASIS, l.aBasis & ((1n << 64n) - 1n), true);
      v.setBigUint64(o + C.LEG_A_BASIS + 8, l.aBasis >> 64n, true);
      v.setBigUint64(o + C.LEG_EPOCH_SNAP, l.epochSnap, true);
    }
    return d;
  };
  const sides = (o: Partial<{ aLong: bigint; aShort: bigint; epochLong: bigint; epochShort: bigint; modeLong: number; modeShort: number }> = {}) => ({
    aLong: ADL_ONE, aShort: ADL_ONE, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0, ...o,
  });

  it("4EGvEGdL: raw short -9.724B, A_short 0.241418 -> effective -2.348B (counter == basis, real is ADL'd)", () => {
    const raw = 9_724_439_576n;
    const aShort = (ADL_ONE * 241_418n) / 1_000_000n;
    const d = portfolio([{ slot: 0, asset: 0, marketId: MARKET_ID, side: 1, basis: -raw, aBasis: ADL_ONE, epochSnap: 0n }]);
    const eff = lpEffectiveSignedQ(d, sides({ aShort }), 0, MARKET_ID)!;
    expect(eff).toBe(-((raw * aShort + ADL_ONE - 1n) / ADL_ONE)); // ceil, engine kernel_adl_effective_quantity_ceil
    expect(eff).toBeGreaterThan(-raw);
  });

  it("Gprscv7A: prior-reset obligation (ResetPending, epoch_snap + 1 == epoch) owns 0", () => {
    const d = portfolio([{ slot: 0, asset: 0, marketId: MARKET_ID, side: 0, basis: 14_025_245_441n, aBasis: ADL_ONE, epochSnap: 0n }]);
    expect(lpEffectiveSignedQ(d, sides({ epochLong: 1n, modeLong: SIDE_MODE_RESET_PENDING }), 0, MARKET_ID)).toBe(0n);
  });

  it("first matching leg only (asset + market id); no leg = flat; InvalidLeg = null", () => {
    const d = portfolio([
      { slot: 0, asset: 1, marketId: MARKET_ID, side: 0, basis: 5n, aBasis: ADL_ONE, epochSnap: 0n },
      { slot: 1, asset: 0, marketId: 99n, side: 0, basis: 6n, aBasis: ADL_ONE, epochSnap: 0n },
      { slot: 2, asset: 0, marketId: MARKET_ID, side: 0, basis: 7n, aBasis: ADL_ONE, epochSnap: 0n },
    ]);
    expect(lpEffectiveSignedQ(d, sides(), 0, MARKET_ID)).toBe(7n);
    expect(lpEffectiveSignedQ(d, sides(), 3, MARKET_ID)).toBe(0n);
    expect(lpEffectiveSignedQ(d, sides({ epochLong: 5n }), 0, MARKET_ID)).toBeNull();
    expect(lpEffectiveSignedQ(new Uint8Array(10), sides(), 0, MARKET_ID)).toBeNull();
  });
});

describe("ticket side limits (maxTradeSizePerSide) use the same room", () => {
  const cap = 14_025_245_441n;
  const base = {
    priceE6: 1_000_000n, initialMarginBps: 1000n, oiEffLongQ: 0n, oiEffShortQ: 0n,
    limits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0 }, lp: null, takerPosQ: 0n,
  };
  it("pre-upgrade drifted: short 0 / long cap; legacy caller (no lpRealQ) keeps counter-only", () => {
    const pre = maxTradeSizePerSide({ ...base, matcher: { maxFillAbs: 0n, maxInventoryAbs: cap, inventoryBase: cap, lpRealQ: 0n, syncLive: false } });
    expect(pre.short.maxQ).toBe(0n);
    expect(pre.long.maxQ).toBe(cap);
    const legacy = maxTradeSizePerSide({ ...base, matcher: { maxFillAbs: 0n, maxInventoryAbs: cap, inventoryBase: cap } });
    expect(legacy.long.maxQ).toBe(2n * cap);
  });
  it("post-upgrade: real position", () => {
    const post = maxTradeSizePerSide({ ...base, matcher: { maxFillAbs: 0n, maxInventoryAbs: cap, inventoryBase: cap, lpRealQ: 0n, syncLive: true } });
    expect(post.short.maxQ).toBe(cap);
    expect(post.short.reason).toBe("matcher-inventory");
  });
});
