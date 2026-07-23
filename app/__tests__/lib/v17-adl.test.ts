import { describe, it, expect } from "vitest";
import {
  ADL_ONE,
  parseAssetAdlFactors,
  adlSideFactor,
  effectiveExposureQ,
  adlRemainingBps,
  isDeleveraged,
} from "@/lib/v17-adl";
import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";

/**
 * Regression cover for the "auto-deleveraged position over-reports its size" bug.
 *
 * ON-CHAIN GROUND TRUTH (percolator/src/v16.rs, read-only):
 *   `reduce_matching_open_interest_for_unilateral_close` (12520-12556) scales the
 *   OPPOSITE side's shared `a_long`/`a_short` by `oi_after / oi_before` and never
 *   touches any leg's `basis_pos_q`. Each leg froze the then-current factor into
 *   `leg.a_basis` at attach time (11600-11616), and settlement rewrites only
 *   `k_snap`/`f_snap` (9657-9658) — never `a_basis`. Settlement realizes
 *   `basis * (k_now - k_snap) / (a_basis * POS_SCALE)` (9547-9576) while `k`
 *   accrues per side scaled by that side's live `a` (10497-10502), so a leg's
 *   real exposure is `basis * a_side / a_basis`.
 *
 * Consequence: any client reading size/exposure/notional from `basis_pos_q`
 * over-reports a deleveraged position by `a_basis / a_side` — up to 10x, since
 * `a` floors at MIN_A_SIDE = ADL_ONE/10.
 */

/** Layout constants mirrored from lib/v17-adl.ts (see its doc comment). */
const SLOTS_BASE = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
const WRAPPER = 512;
const A_LONG_REL = 49;
const A_SHORT_REL = 65;
const OI_LONG_REL = 273;

function writeU128LE(buf: Uint8Array, off: number, v: bigint): void {
  let x = v;
  for (let i = 0; i < 16; i++) {
    buf[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

/** Build a synthetic v17 market account with the given per-side ADL factors. */
function makeSlab(aLong: bigint, aShort: bigint, slots = 1): Uint8Array {
  const buf = new Uint8Array(SLOTS_BASE + slots * V17_MARKET_ASSET_SLOT_LEN);
  for (let i = 0; i < slots; i++) {
    const base = SLOTS_BASE + i * V17_MARKET_ASSET_SLOT_LEN + WRAPPER;
    writeU128LE(buf, base + A_LONG_REL, aLong);
    writeU128LE(buf, base + A_SHORT_REL, aShort);
  }
  return buf;
}

describe("parseAssetAdlFactors", () => {
  it("reads a never-deleveraged market as ADL_ONE on both sides", () => {
    const f = parseAssetAdlFactors(makeSlab(ADL_ONE, ADL_ONE), 0);
    expect(f).not.toBeNull();
    expect(f!.aLong).toBe(ADL_ONE);
    expect(f!.aShort).toBe(ADL_ONE);
  });

  it("reads a half-deleveraged short side", () => {
    // F1LHGasi / FysUBWXp on the live playground both carry exactly this.
    const f = parseAssetAdlFactors(makeSlab(ADL_ONE, ADL_ONE / 2n), 0);
    expect(f!.aShort).toBe(500_000_000_000_000n);
  });

  it("refuses a buffer too short to hold the asset slot", () => {
    expect(parseAssetAdlFactors(new Uint8Array(SLOTS_BASE + 10), 0)).toBeNull();
  });

  it("refuses out-of-range factors rather than scaling by garbage", () => {
    // Below MIN_A_SIDE (= ADL_ONE/10) means we are not looking at an
    // AssetStateV16Account — returning null keeps the caller on raw basis.
    expect(parseAssetAdlFactors(makeSlab(ADL_ONE, 1n), 0)).toBeNull();
    expect(parseAssetAdlFactors(makeSlab(ADL_ONE * 2n, ADL_ONE), 0)).toBeNull();
    expect(parseAssetAdlFactors(makeSlab(0n, 0n), 0)).toBeNull();
  });

  it("does not confuse the a-factors with oi_eff_long_q 224 bytes later", () => {
    // Guards the 49/65 offsets: if they ever drifted onto the OI fields the
    // range check would mostly still pass, so pin the distance explicitly.
    const buf = makeSlab(ADL_ONE, ADL_ONE);
    writeU128LE(buf, SLOTS_BASE + WRAPPER + OI_LONG_REL, 12_345n);
    const f = parseAssetAdlFactors(buf, 0);
    expect(f!.aLong).toBe(ADL_ONE);
    expect(OI_LONG_REL - A_LONG_REL).toBe(14 * 16);
  });
});

describe("effectiveExposureQ — the reported bug", () => {
  it("REPRODUCES the 2x over-report and corrects it (live portfolio 5RKoNWaV)", () => {
    // Live devnet: market F1LHGasi has a_short = ADL_ONE/2; portfolio
    // 5RKoNWaV holds a SHORT leg with basis_pos_q = -1_000_000 and
    // a_basis = ADL_ONE. Its true exposure is half that, which is exactly
    // what the market's own oi_eff_short_q (500_000) reports.
    const basis = -1_000_000n;
    const aBasis = ADL_ONE;
    const aSide = ADL_ONE / 2n;

    // The pre-fix behaviour: raw basis, 2x too large.
    expect(basis).toBe(-1_000_000n);
    // The fix:
    expect(effectiveExposureQ(basis, aBasis, aSide)).toBe(-500_000n);
    expect(adlRemainingBps(aBasis, aSide)).toBe(5000);
    expect(isDeleveraged(aBasis, aSide)).toBe(true);
  });

  it("matches oi_eff_short_q on every live deleveraged market", () => {
    // basis, a_short, engine's own oi_eff_short_q for that market.
    const cases: Array<[bigint, bigint, bigint]> = [
      [-1_000_000n, 500_000_000_000_000n, 500_000n], // F1LHGasi
      [-1_000_000n, 500_000_000_000_000n, 500_000n], // FysUBWXp
      [-4_000_000n, 750_000_000_000_000n, 3_000_000n], // GsBBecjF
    ];
    for (const [basis, aShort, oiEff] of cases) {
      expect(effectiveExposureQ(basis, ADL_ONE, aShort)).toBe(-oiEff);
    }
  });

  it("floors sub-unit remainders (live portfolio C6JxYSMi)", () => {
    // D4QsJSG9: a_short = 606060606060606 (a repeating 0.60606…), basis
    // -330_000. Engine reports oi_eff_short_q = 200_000; the per-leg floor
    // lands one atom below. Sub-unit, and deliberately conservative.
    const eff = effectiveExposureQ(-330_000n, ADL_ONE, 606_060_606_060_606n);
    expect(eff).toBe(-199_999n);
    expect(-eff).toBeLessThanOrEqual(200_000n);
  });

  it("is a no-op on a market that was never deleveraged", () => {
    expect(effectiveExposureQ(1_000_000n, ADL_ONE, ADL_ONE)).toBe(1_000_000n);
    expect(adlRemainingBps(ADL_ONE, ADL_ONE)).toBe(10000);
    expect(isDeleveraged(ADL_ONE, ADL_ONE)).toBe(false);
  });

  it("does NOT flag a leg opened after someone else's ADL", () => {
    // A leg attached while a_short was already 0.5 froze a_basis = 0.5, so it
    // carries its full nominal exposure. Flagging it would tell the trader
    // their position was cut when it never was.
    const half = ADL_ONE / 2n;
    expect(effectiveExposureQ(-800_000n, half, half)).toBe(-800_000n);
    expect(isDeleveraged(half, half)).toBe(false);
    expect(adlRemainingBps(half, half)).toBe(10000);
  });

  it("scales longs and shorts symmetrically", () => {
    const aSide = ADL_ONE / 4n;
    expect(effectiveExposureQ(1_000_000n, ADL_ONE, aSide)).toBe(250_000n);
    expect(effectiveExposureQ(-1_000_000n, ADL_ONE, aSide)).toBe(-250_000n);
  });

  it("survives the deepest ADL the engine permits (MIN_A_SIDE = 10x)", () => {
    const minA = ADL_ONE / 10n;
    expect(effectiveExposureQ(-1_000_000n, ADL_ONE, minA)).toBe(-100_000n);
    expect(adlRemainingBps(ADL_ONE, minA)).toBe(1000);
  });

  it("falls back to raw basis rather than dividing by zero", () => {
    expect(effectiveExposureQ(500n, 0n, ADL_ONE)).toBe(500n);
    expect(effectiveExposureQ(500n, ADL_ONE, 0n)).toBe(500n);
    expect(effectiveExposureQ(0n, ADL_ONE, ADL_ONE / 2n)).toBe(0n);
  });
});

describe("adlSideFactor", () => {
  it("routes side 0 to a_long and side 1 to a_short", () => {
    const f = { aLong: ADL_ONE, aShort: ADL_ONE / 2n };
    expect(adlSideFactor(f, 0)).toBe(ADL_ONE);
    expect(adlSideFactor(f, 1)).toBe(ADL_ONE / 2n);
  });
});
