// @vitest-environment node
/**
 * #3610: a lot market's InitMarket price is the per-LOT price (wrapper v16_program.rs: `initial_price` is the per-lot mark,
 * refused under LOT_PRICE_FLOOR_E6 = 10^7 with Custom 119). It used to be built from the per-token price ROUNDED to a whole e6
 * and then multiplied by 10^lotExp, so the rounding error was multiplied too: $0.0000015 launched at $20 per lot instead of $15.
 * Now the per-lot price is rounded ONCE, at the per-lot e6, from the unrounded decimal price, and the lot size is picked from
 * that same per-lot value (so the value actually sent clears the program's floor). Prices >= $10 (no lot) are unchanged.
 */
import { describe, expect, it } from "vitest";
import { decimalPriceToScaled, toInitialPriceE6 } from "@/lib/initial-price";
import { launchInitialPriceE6, lotLaunchPrice, planLaunchV22, toLaunchParams, type LaunchPlanInput } from "@/lib/v22/launch-plan";
import { LOT_PRICE_FLOOR_E6_V22, lotExpForTokenPriceV22 } from "@/lib/v22/sdk";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
__setLotMarketsEnabledForTest(true);

const plan = (price: string, over: Partial<LaunchPlanInput> = {}) => {
  const r = toInitialPriceE6(price);
  return planLaunchV22({ tokenPriceE6: r.ok ? r.e6 : 0n, tokenPrice: price, collateralDecimals: 6, oracleMode: "keeper", growthOn: true, ...over });
};

/** Exact per-lot e6 of a plain decimal string as a fraction num / den (independent of the code under test). */
function exactPerLotE6(price: string, lotExp: number): { num: bigint; den: bigint } {
  const [i, f = ""] = price.split(".");
  return { num: BigInt(i + f) * 10n ** BigInt(6 + lotExp), den: 10n ** BigInt(f.length) };
}
/** |sent - exact| <= 0.5 e6, in integers: |2 * sent * den - 2 * num| <= den. */
const withinHalfE6 = (sent: bigint, x: { num: bigint; den: bigint }): boolean => {
  const d = 2n * sent * x.den - 2n * x.num;
  return (d < 0n ? -d : d) <= x.den;
};

describe("the issue's examples", () => {
  it("$0.0000014 launches at $14 per lot (was $10, -29%)", () => {
    const p = plan("0.0000014");
    expect(p.lotExp).toBe(7);
    expect(p.perLotPriceE6).toBe(14_000_000n);
  });
  it("$0.0000015 launches at $15 per lot (was $20, +33%)", () => {
    const p = plan("0.0000015");
    expect(p.lotExp).toBe(7);
    expect(p.perLotPriceE6).toBe(15_000_000n);
  });
});

describe("table: the per-lot price is within 0.5 e6 of the true per-lot price, at the smallest lot that clears $10", () => {
  const rows = [
    // the $0.000001 .. $0.00001 window the issue names (1 to 10 e6 steps per token)
    "0.000001", "0.0000011", "0.0000014", "0.0000015", "0.0000019", "0.0000025", "0.00000333", "0.0000049", "0.0000051",
    "0.00000777", "0.0000094", "0.0000095", "0.0000096", "0.00000999", "0.000009999999", "0.00001",
    // normal sub-$10 prices
    "0.0000123", "0.00004567", "0.0004", "0.0124", "0.0131", "0.123456789", "1.2345678", "3.14159265", "9.99", "9.9999994",
  ];
  for (const price of rows) {
    it(price, () => {
      const p = plan(price);
      expect(p.issues).toEqual([]);
      expect(p.perLotPriceE6).toBeGreaterThanOrEqual(LOT_PRICE_FLOOR_E6_V22);
      expect(withinHalfE6(p.perLotPriceE6, exactPerLotE6(price, p.lotExp))).toBe(true);
      // the smallest lot whose per-lot price (rounded once) clears the program floor
      if (p.lotExp > 0) expect(decimalPriceToScaled(price, 6 + p.lotExp - 1)! < LOT_PRICE_FLOOR_E6_V22).toBe(true);
      // what InitMarket is sent is exactly the plan's per-lot price
      expect(launchInitialPriceE6(p, toLaunchParams(p), toInitialPriceE6(price).ok ? (toInitialPriceE6(price) as { e6: bigint }).e6 : 0n)).toBe(p.perLotPriceE6);
    });
  }
  it("$0.0000096 needs a 10^7 lot: at 10^6 the per-lot price ($9.60) is under the program's $10 floor (the rounded price picked 10^6 and sent $10)", () => {
    const p = plan("0.0000096");
    expect(p.lotExp).toBe(7);
    expect(p.perLotPriceE6).toBe(96_000_000n);
  });
});

describe("prices of $10 and above (no lot) are byte-identical to before", () => {
  const rows = ["10", "10.0000004", "10.0000005", "12.5", "54", "150.123456", "150.1234565", "1000", "99999.999999", "999999.999999"];
  for (const price of rows) {
    it(price, () => {
      const r = toInitialPriceE6(price);
      if (!r.ok) throw new Error("fixture");
      const before = planLaunchV22({ tokenPriceE6: r.e6, collateralDecimals: 6, oracleMode: "keeper", growthOn: true });
      const after = plan(price);
      expect(before.lotExp).toBe(0);
      expect(after).toEqual(before);
      expect(after.perLotPriceE6).toBe(r.e6);
      expect(lotLaunchPrice(price)).toEqual({ lotExp: 0, perLotPriceE6: r.e6 });
      expect(launchInitialPriceE6(after, toLaunchParams(after), r.e6)).toBe(r.e6);
    });
  }
  it("no v2.2 block (flag-off shape): the per-token price as before", () => {
    expect(launchInitialPriceE6(null, undefined, 1_234n)).toBe(1_234n);
  });
});

describe("lot choice agrees between the wizard's floor and the plan", () => {
  for (const price of ["0.0000014", "0.0000095", "0.0000096", "0.0004", "1.2345678", "12.5"]) {
    it(price, () => {
      expect(lotLaunchPrice(price)?.lotExp).toBe(plan(price).lotExp);
    });
  }
  it("without the decimal price the plan keeps its e6 behaviour (callers that only hold e6)", () => {
    const p = planLaunchV22({ tokenPriceE6: 2n, collateralDecimals: 6, oracleMode: "keeper", growthOn: true });
    expect(p.lotExp).toBe(lotExpForTokenPriceV22(2n));
    expect(p.perLotPriceE6).toBe(20_000_000n);
  });
  it("a decimal price that does not match the e6 price is ignored (never mix two prices)", () => {
    const p = planLaunchV22({ tokenPriceE6: 2n, tokenPrice: "0.0000031", collateralDecimals: 6, oracleMode: "keeper", growthOn: true });
    expect(p.perLotPriceE6).toBe(20_000_000n);
  });
});

describe("decimalPriceToScaled: exact, half-up, from the digits", () => {
  it.each([
    ["0.0000015", 13, 15_000_000n],
    ["0.0000014", 13, 14_000_000n],
    ["1.5e-6", 13, 15_000_000n],
    ["1.5E-6", 6, 2n],
    ["0.00000149", 12, 1_490_000n],
    ["1.0000005", 6, 1_000_001n], // float maths gives 1000000.4999999999 -> 1000000
    ["0.0124", 9, 12_400_000n],
    [" 2.5 ", 0, 3n],
    ["1.5abc", 1, 15n], // parseFloat semantics, as toInitialPriceE6
    ["12", 3, 12_000n],
  ] as const)("%s x 10^%i", (s, scale, want) => {
    expect(decimalPriceToScaled(s, scale)).toBe(want);
  });
  it.each(["", "abc", "0", "-1", "NaN", "Infinity"])("%s is not a price", (s) => {
    expect(decimalPriceToScaled(s, 6)).toBeNull();
  });
  it("null / undefined", () => {
    expect(decimalPriceToScaled(null, 6)).toBeNull();
    expect(decimalPriceToScaled(undefined, 6)).toBeNull();
  });
});
