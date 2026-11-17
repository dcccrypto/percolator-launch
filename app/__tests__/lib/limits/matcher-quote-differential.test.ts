/**
 * Differential: the optimized matcher-quote vs a frozen copy of the pre-optimization module
 * (matcher-quote.reference.ts). Every returned field must be equal.
 */
import { describe, expect, it } from "vitest";
import * as next from "@/lib/limits/matcher-quote";
import * as ref from "./matcher-quote.reference";
import { genCases } from "../../bench/matcher-quote-inputs";

describe("matcher-quote differential (old vs new)", () => {
  it("preTradeQuote + quoteFailsLimit + skewIndicatorBps agree on 60k random inputs", () => {
    const cases = [...genCases(40_000, 1, true), ...genCases(20_000, 2, false)];
    let nonNull = 0;
    let clipped = 0;
    let zeroFill = 0;
    let limit0 = 0;
    for (const c of cases) {
      const a = ref.preTradeQuote(c.ctx, c.oracleE6, c.sizeQ, c.takerBuys, c.opts);
      const b = next.preTradeQuote(c.ctx, c.oracleE6, c.sizeQ, c.takerBuys, c.opts);
      expect(b).toEqual(a);
      if (a) {
        nonNull++;
        if (a.clippedByTotal) clipped++;
        if (a.fillQ === 0n) zeroFill++;
      }
      if (c.limitE6 === 0n) limit0++;
      const qp = a ? a.quotePriceE6 : null;
      expect(next.quoteFailsLimit(qp, c.limitE6, c.takerBuys)).toBe(ref.quoteFailsLimit(qp, c.limitE6, c.takerBuys));
      expect(next.skewIndicatorBps(c.ctx.inventoryBase, c.invRef)).toBe(ref.skewIndicatorBps(c.ctx.inventoryBase, c.invRef));
    }
    // the generator really covers the edges
    expect(nonNull).toBeGreaterThan(20_000);
    expect(clipped).toBeGreaterThan(1_000);
    expect(zeroFill).toBeGreaterThan(500);
    expect(limit0).toBeGreaterThan(1_000);
  }, 300_000);

  it("skewIndicatorBps agrees at and around the 10_000 bps cap", () => {
    const refInv = 1_000_000_000n;
    for (const inv of [0n, refInv, -refInv, refInv + 1n, -refInv - 1n, 3n * refInv, -3n * refInv, refInv - 1n]) {
      expect(next.skewIndicatorBps(inv, refInv)).toBe(ref.skewIndicatorBps(inv, refInv));
    }
    expect(next.skewIndicatorBps(refInv, refInv)).toBe(10_000);
    expect(next.skewIndicatorBps(5n, 0n)).toBe(0);
  });

  it("quoteAdaptive agrees directly with fill 0 / inventory at the cap", () => {
    const base = {
      oracleE6: 1_000_000n, takerBuys: true, baseSpreadBps: 5, maxTotalBps: 100, feeBps: 10n, impactKBps: 5000,
      depthE6: 1_000_000_000_000n, sMultBps: 300, rMultBps: 100, skewCapBps: 100, rebateCapBps: 50, refInv: 1_000_000_000n,
    };
    for (const fill of [0n, 1n, 1_000_000n, 10_000_000_000n]) {
      for (const invPre of [0n, 1_000_000_000n, -1_000_000_000n]) {
        for (const takerBuys of [true, false]) {
          const q = { ...base, fill, invPre, takerBuys };
          expect(next.quoteAdaptive(q)).toEqual(ref.quoteAdaptive(q));
        }
      }
    }
  });
});
