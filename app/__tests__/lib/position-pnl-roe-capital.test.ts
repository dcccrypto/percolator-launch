// @vitest-environment node
/** M7: PnL % (ROE) divides by the position's capital (its margin), not by notional / max leverage. */
import { describe, expect, it } from "vitest";
import { computePositionPnl, valueAtMark, type PositionPnlInput } from "@/lib/position-pnl";

const ONE = 1_000_000_000_000_000n;
// 40 tokens long, entry $100 (cached), mark $101 => +$40 PnL. Notional $4,000; at 1000 bps initial margin => $400; capital $800 (5x).
const base: PositionPnlInput = {
  basisQ: 40_000_000n,
  aBasis: ONE,
  adlFactors: { aLong: ONE, aShort: ONE },
  markE6: 101_000_000n,
  cachedEntryE6: 100_000_000n,
  onChainPnl: 0n,
  initialMarginBps: 1000n,
  capital: 800_000_000n,
};

describe("ROE denominator (M7)", () => {
  it("a 5x position's ROE is PnL / capital (5.0%), not PnL / (notional/10) (10.0%)", () => {
    const r = computePositionPnl(base);
    expect(r.unrealizedPnl).toBe(40_000_000n);
    expect(r.roe).toBeCloseTo(5, 5);
  });
  it("several open legs share the capital: ROE falls back to the position's own initial margin", () => {
    const r = computePositionPnl({ ...base, activeLegCount: 2 });
    expect(r.roe).toBeCloseTo(10, 5);
  });
  it("no capital: initial margin is still the fallback", () => {
    expect(computePositionPnl({ ...base, capital: 0n }).roe).toBeCloseTo(10, 5);
  });
  it("valueAtMark: the spec'd example, loss sign preserved", () => {
    const v = valueAtMark({ effectiveSize: 40_000_000n, entryE6: 100_000_000n, markE6: 99_000_000n, initialMarginBps: 1000n, capital: 800_000_000n });
    expect(v.roe).toBeCloseTo(-5, 5);
  });
});
