// @vitest-environment node
/**
 * Differential for lib/position-pnl.ts: >= 2,000 seeded random portfolios compared with an independent
 * re-statement of the engine rules quoted in the code comments:
 *   - effective size  = ceil(|basis| * a_side / a_basis)  (kernel_adl_effective_quantity_ceil, v16.rs:1677)
 *   - unrealized PnL  = floor(effective * (mark - entry) / 1e6), floored toward -inf (floor_div_signed_conservative)
 *   - ROE             = trunc(pnl * 10_000 / denominator) / 100; denominator = capital (single leg) or the
 *                       position's initial margin on EFFECTIVE size (several legs), capital if that margin is 0.
 * The vendored v2.2 SDK (lib/v22/sdk) has no PnL function, so the rule is restated here, not imported.
 */
import { describe, expect, it } from "vitest";
import { computePositionPnl, valueAtMark } from "@/lib/position-pnl";

const ONE = 1_000_000_000_000_000n;
const N = 2500;

// mulberry32, fixed seed
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(0x20261116);
const big = (lo: number, hi: number) => BigInt(Math.floor(lo + R() * (hi - lo)));

const floorDiv = (n: bigint, d: bigint) => {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
};
const ceilDiv = (n: bigint, d: bigint) => -floorDiv(-n, d);
const refPnl = (q: bigint, entry: bigint, mark: bigint) => floorDiv(q * (mark - entry), 1_000_000n);
const refRoe = (pnl: bigint, den: bigint) => Number((pnl * 10_000n) / den) / 100;

describe("position-pnl differential vs engine rule (seeded)", () => {
  it(`${N} random portfolios: effective size, unrealized PnL, ROE, value match`, () => {
    let mismatches = 0;
    const bad: string[] = [];
    for (let i = 0; i < N; i++) {
      const long = R() < 0.5;
      const absBasis = big(1, 5_000_000_000);
      const aBasis = ONE - big(0, 800_000_000_000_000);
      const aSide = 1n + (aBasis - 1n) * BigInt(Math.floor(R() * 1000)) / 1000n;
      const lo = aSide < 100_000_000_000_000n ? 100_000_000_000_000n : aSide;
      const aSideOk = lo > aBasis ? aBasis : lo;
      const entry = big(1_000, 900_000_000);
      const mark = big(1_000, 900_000_000);
      const capital = R() < 0.1 ? 0n : big(1, 5_000_000_000);
      const legs = R() < 0.5 ? 1 : 2;
      const bps = big(100, 5000);
      const eff = ceilDiv(absBasis * aSideOk, aBasis);
      const signed = long ? eff : -eff;
      const got = computePositionPnl({
        basisQ: long ? absBasis : -absBasis,
        aBasis,
        adlFactors: long ? { aLong: aSideOk, aShort: ONE } : { aLong: ONE, aShort: aSideOk },
        markE6: mark,
        cachedEntryE6: entry,
        onChainPnl: 0n,
        initialMarginBps: bps,
        capital,
        activeLegCount: legs,
      });
      const pnl = refPnl(signed, entry, mark);
      const im = (eff * entry / 1_000_000n) * bps / 10_000n;
      const den = capital > 0n && legs <= 1 ? capital : im > 0n ? im : capital;
      const roe = den > 0n ? refRoe(pnl, den) : 0;
      const ok =
        got.effectiveSize === signed && got.unrealizedPnl === pnl && got.riskUnrealizedPnl === pnl && got.pnlKnown && Math.abs((got.roe as number) - roe) < 1e-9;
      if (!ok) {
        mismatches++;
        if (bad.length < 5) bad.push(JSON.stringify({ i, signed, pnl, roe, got }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
    }
    // eslint-disable-next-line no-console
    console.log(`differential: ${N} portfolios, ${mismatches} mismatches`, bad);
    expect(mismatches).toBe(0);
  });

  it("derived (back-solved) entry: value side keeps capital + pnl at the anchor mark, within one price tick of size", () => {
    let mismatches = 0;
    for (let i = 0; i < N; i++) {
      const long = R() < 0.5;
      const absBasis = big(1_000_000, 5_000_000_000);
      const mark = big(1_000_000, 900_000_000);
      const pnl = big(1, 2_000_000_000) * (R() < 0.5 ? 1n : -1n);
      const got = computePositionPnl({
        basisQ: long ? absBasis : -absBasis,
        aBasis: ONE,
        adlFactors: { aLong: ONE, aShort: ONE },
        markE6: mark,
        onChainPnl: pnl,
        initialMarginBps: 1000n,
        capital: 1_000_000_000n,
      });
      if (got.entrySource !== "derived") continue;
      const tol = absBasis / 1_000_000n + 1n;
      const diff = (got.riskUnrealizedPnl as bigint) - pnl;
      if ((diff < 0n ? -diff : diff) > tol || got.unrealizedPnl !== null || got.pnlKnown) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe("lead 1: valueAtMark ROE denominators", () => {
  it("dust margin on a multi-leg account falls back to the SHARED capital (documented behaviour, not a bug)", () => {
    // size 100 atoms @ $1: notional 0 atoms -> margin 0 -> falls back to account capital.
    const v = valueAtMark({ effectiveSize: 5n, entryE6: 1_000_000n, markE6: 2_000_000n, initialMarginBps: 1000n, capital: 1000n, capitalIsPositionMargin: false });
    expect(v.unrealizedPnl).toBe(5n);
    expect(v.roe).toBe(0.5);
  });
  it("huge PnL over dust margin clamps instead of throwing (the catch at :225 is unreachable)", () => {
    const v = valueAtMark({ effectiveSize: 10n ** 14n, entryE6: 1n, markE6: 10n ** 12n, initialMarginBps: 1n, capital: 0n, capitalIsPositionMargin: false });
    expect(Number.isFinite(v.roe)).toBe(true);
  });
});

describe("lead 3: partial account shape (aBasis missing => 0n)", () => {
  it("an ADL-applicable leg with a_basis 0 is UNKNOWN (never priced on raw basis)", () => {
    const r = computePositionPnl({
      basisQ: 5_000_000n,
      aBasis: 0n,
      adlFactors: { aLong: ONE, aShort: ONE },
      markE6: 2_000_000n,
      cachedEntryE6: 1_000_000n,
      onChainPnl: 0n,
      initialMarginBps: 1000n,
      capital: 1_000_000n,
    });
    expect(r.effectiveSize).toBeNull();
    expect(r.pnlKnown).toBe(false);
    expect(r.unrealizedPnl).toBeNull();
  });
});
