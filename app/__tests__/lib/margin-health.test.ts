/**
 * The liquidation price is absent for most playground positions, because
 * cross-margin collateral exceeds their notional — and the surfaces that lead
 * with it then show a dash and nothing else.
 *
 * Margin health is the figure that survives that, and it already existed on
 * one surface (PositionPanel). These pin its contract before it is shared.
 *
 * See lib/margin-health.ts.
 */

import { describe, expect, it } from "vitest";
import {
  computeMarginHealthPct,
  marginHealthBand,
  unliquidatableHealthThresholdPct,
} from "@/lib/margin-health";
import { computeLiqPrice } from "@/lib/trading";

const E6 = 1_000_000n;
const MARK = 1n * E6; // $1.00
const SIZE = 200n * E6; // 200 units -> $200 notional
const MM = 500n; // 5%

/** The shipped (engine-consistent) formula: liq clamps to 0 past the threshold. */
const liqPrice = computeLiqPrice;

describe("margin health exists when the liquidation price does not", () => {
  it("is defined with no entry price and no liquidation price", () => {
    // The whole point: this needs only capital, size and a mark.
    expect(computeMarginHealthPct(250n * E6, SIZE, MARK)).toBe(125);
    expect(liqPrice(MARK, 250n * E6, SIZE, MM)).toBe(0n); // no liq price at all
  });

  it("crosses its threshold exactly where the liquidation price disappears", () => {
    // health >= 100%  <=>  no liq price (engine model, #2987). Same fact, two expressions.
    const threshold = unliquidatableHealthThresholdPct(MM);
    expect(threshold).toBe(100);

    const justBelow = 199n * E6;
    const atLine = 200n * E6;
    expect(computeMarginHealthPct(justBelow, SIZE, MARK)).toBeLessThan(threshold);
    expect(liqPrice(MARK, justBelow, SIZE, MM)).toBeGreaterThan(0n);

    expect(computeMarginHealthPct(atLine, SIZE, MARK)).toBeGreaterThanOrEqual(threshold);
    expect(liqPrice(MARK, atLine, SIZE, MM)).toBe(0n);
  });

  it("tracks collateral the way the liquidation price does", () => {
    expect(computeMarginHealthPct(100n * E6, SIZE, MARK)).toBe(50);
    expect(computeMarginHealthPct(200n * E6, SIZE, MARK)).toBe(100);
  });
});

describe("it must not overstate safety", () => {
  it("CONTROL: uses NOMINAL size, so a deleveraged position is not flattered", () => {
    // ADL reduces exposure without rewriting the leg basis. Feeding the
    // REDUCED size shrinks the denominator and reports a deleveraged position
    // as healthier than it is — the one direction a risk number must never
    // fail in, and what PositionPanel's own comment warns about.
    const nominal = SIZE;
    const reducedByAdl = SIZE / 2n;
    const capital = 100n * E6;

    const honest = computeMarginHealthPct(capital, nominal, MARK);
    const flattering = computeMarginHealthPct(capital, reducedByAdl, MARK);

    expect(honest).toBe(50);
    expect(flattering).toBe(100);
    expect(flattering!).toBeGreaterThan(honest!); // the trap, stated explicitly
  });

  it("returns null rather than a number when it cannot be computed", () => {
    // No position, or no mark. Null is not 100 — see #2556: an absent risk
    // signal that renders as a figure is how "safe" got shown for no data.
    expect(computeMarginHealthPct(100n * E6, 0n, MARK)).toBeNull();
    expect(computeMarginHealthPct(100n * E6, SIZE, 0n)).toBeNull();
  });

  it("CONTROL: a null health has no band, rather than a safe one", () => {
    expect(marginHealthBand(null, MM)).toBeNull();
    expect(marginHealthBand(Number.NaN, MM)).toBeNull();
  });
});

describe("bands are anchored to the liquidation threshold, not invented", () => {
  it("at or above the threshold the position is covered", () => {
    expect(marginHealthBand(100, MM)).toBe("covered");
    expect(marginHealthBand(400, MM)).toBe("covered");
  });

  it("below it, lower health is worse", () => {
    expect(marginHealthBand(99, MM)).toBe("safe"); // just under the line
    expect(marginHealthBand(80, MM)).toBe("warning");
    expect(marginHealthBand(50, MM)).toBe("danger");
    expect(marginHealthBand(1, MM)).toBe("danger");
  });

  it("CONTROL: the line is where the engine-consistent liquidation price disappears, at every mm", () => {
    // The SDK's old formula put it at (100 + mm)%; the engine never liquidates a long whose
    // collateral covers its notional, whatever the maintenance margin.
    for (const mm of [0n, 500n, 1_000n, 1_666n]) {
      expect(unliquidatableHealthThresholdPct(mm)).toBe(100);
      expect(computeLiqPrice(MARK, 200n * E6, SIZE, mm)).toBe(0n); // health 100%
      expect(computeLiqPrice(MARK, 199n * E6, SIZE, mm)).toBeGreaterThan(0n); // 99.5%
    }
  });
});

describe("the threshold must not throw during a render", () => {
  it("accepts a number as well as a bigint", () => {
    // The declared type is bigint, but this feeds a risk readout rendered
    // during paint — a "Cannot mix BigInt and other types" throw from one
    // mistyped caller blanks the whole row instead of one figure. Found by
    // Portfolio.test.tsx, whose mock supplies a plain number.
    expect(unliquidatableHealthThresholdPct(500 as unknown as bigint)).toBe(100);
    expect(unliquidatableHealthThresholdPct(500n)).toBe(100);
    expect(marginHealthBand(110, 500 as unknown as bigint)).toBe("covered");
  });

  it("degrades to a usable default rather than NaN", () => {
    expect(unliquidatableHealthThresholdPct(Number.NaN as unknown as bigint)).toBe(100);
    expect(unliquidatableHealthThresholdPct(-1 as unknown as bigint)).toBe(100);
  });
});

describe("computeMarginHealthPct must not throw during a render either", () => {
  it("accepts numbers without mixing BigInt types", () => {
    // Caught by Portfolio.test.tsx: mocked positions supply plain numbers, and
    // `absNominal * markPriceE6` threw, blanking every row in the component
    // rather than one figure.
    expect(
      computeMarginHealthPct(
        250_000_000 as unknown as bigint,
        200_000_000 as unknown as bigint,
        1_000_000 as unknown as bigint,
      ),
    ).toBe(125);
  });

  it("returns null for anything it cannot use", () => {
    // Null, not a number: an uncomputable risk figure that renders as a value
    // is exactly the #2556 failure.
    expect(computeMarginHealthPct(null, SIZE, MARK)).toBeNull();
    expect(computeMarginHealthPct(undefined, SIZE, MARK)).toBeNull();
    expect(computeMarginHealthPct(100n * E6, Number.NaN as unknown as bigint, MARK)).toBeNull();
    expect(computeMarginHealthPct(100n * E6, SIZE, Number.POSITIVE_INFINITY as unknown as bigint)).toBeNull();
  });
});
