/**
 * S7: margin health was capital / notional while the liquidation price is solved on
 * equity (capital + unrealized PnL). A covered winner read under the 100% line it is
 * past, and a loser read far safer than it was until settlement moved the loss out of
 * capital. Health is now equity / notional, valued with the liquidation price's entry.
 */
import { describe, expect, it } from "vitest";
import { computeMarginHealthPct } from "@/lib/margin-health";
import { describeLiqPrice } from "@/lib/liq-price-display";
import { computeEngineLiqPrice } from "@/lib/liquidation-risk";

const E6 = 1_000_000n;
const MM = 500n;

/** One position as a surface sees it: the liq price from the same entry and size. */
function view(capital: bigint, size: bigint, entry: bigint, mark: bigint) {
  return describeLiqPrice({
    liqPriceE6: computeEngineLiqPrice(entry, capital, size, MM),
    positionSize: size,
    capital,
    entryPriceE6: entry,
    effectiveSize: size,
    markPriceE6: mark,
    maintenanceMarginBps: MM,
    hasResolvedEntry: true,
  });
}

describe("computeMarginHealthPct counts unrealized PnL", () => {
  it("adds the PnL to capital", () => {
    // $50 capital, 1 unit, mark $60, loss $40: equity $10 of $60.
    expect(computeMarginHealthPct(50n * E6, 1n * E6, 60n * E6, -40n * E6)).toBe(16.6);
  });
  it("without PnL it is capital alone, as before", () => {
    expect(computeMarginHealthPct(50n * E6, 1n * E6, 60n * E6)).toBe(83.3);
  });
  it("negative equity floors at 0", () => {
    expect(computeMarginHealthPct(10n * E6, 1n * E6, 60n * E6, -40n * E6)).toBe(0);
  });
});

describe("describeLiqPrice health agrees with the liquidation price", () => {
  it("losing long: a real liq price, and health shows the loss (was 83%)", () => {
    const d = view(50n * E6, 1n * E6, 100n * E6, 60n * E6);
    expect(d.kind).toBe("price");
    expect(d.marginHealthPct).toBe(16.6);
  });

  it("losing short (was 35%)", () => {
    const d = view(50n * E6, -1n * E6, 100n * E6, 140n * E6);
    expect(d.marginHealthPct).toBe(7.1);
  });

  it("covered winner reads past the 100% line, not under it (was 66% mgn)", () => {
    const d = view(100n * E6, 1n * E6, 50n * E6, 150n * E6);
    expect(d.kind).toBe("covered");
    expect(d.text).toBe("133% mgn");
    expect(d.title).toContain("equity");
  });

  it("no liquidation price  <=>  health >= 100, for longs across entries and marks", () => {
    const bad: string[] = [];
    for (const cap of [10n, 50n, 100n, 150n, 400n])
      for (const entry of [20n, 50n, 100n, 130n])
        for (const mark of [10n, 40n, 60n, 100n, 150n, 300n]) {
          const d = view(cap * E6, 1n * E6, entry * E6, mark * E6);
          const covered = d.kind === "covered";
          if (covered !== (d.marginHealthPct! >= 100)) bad.push(`cap ${cap} entry ${entry} mark ${mark}: ${d.kind} ${d.marginHealthPct}`);
        }
    expect(bad).toEqual([]);
  });

  it("no entry: the caller's on-chain pnl, else capital alone", () => {
    const base = {
      liqPriceE6: 0n, positionSize: 1n * E6, capital: 80n * E6, effectiveSize: 1n * E6,
      markPriceE6: 100n * E6, maintenanceMarginBps: MM, hasResolvedEntry: false,
    };
    expect(describeLiqPrice({ ...base, entryPriceE6: 0n, onChainPnl: -60n * E6 }).marginHealthPct).toBe(20);
    expect(describeLiqPrice({ ...base, entryPriceE6: null }).marginHealthPct).toBe(80);
  });

  it("unknown ADL state (no effective size): capital alone, never an invented PnL", () => {
    const d = describeLiqPrice({
      liqPriceE6: 0n, positionSize: 1n * E6, capital: 50n * E6, entryPriceE6: 100n * E6, effectiveSize: null,
      markPriceE6: 60n * E6, maintenanceMarginBps: MM, hasResolvedEntry: false,
    });
    expect(d.marginHealthPct).toBe(83.3);
  });
});

describe("covered tooltip under ADL", () => {
  it("a deleveraged leg can be covered below 100% of its nominal notional: no 'past the 100%' claim", () => {
    // Liq price solved on the reduced size (0.5) is clamped; health divides by the nominal 1.
    const d = describeLiqPrice({
      liqPriceE6: computeEngineLiqPrice(100n * E6, 60n * E6, 500_000n, MM),
      positionSize: 1n * E6, capital: 60n * E6, entryPriceE6: 100n * E6, effectiveSize: 500_000n,
      markPriceE6: 100n * E6, maintenanceMarginBps: MM, hasResolvedEntry: true,
    });
    expect(d.kind).toBe("covered");
    expect(d.marginHealthPct).toBe(60);
    expect(d.title).not.toContain("past the");
    expect(d.title).toContain("ADL-reduced");
  });
});

describe("one decimal (S8)", () => {
  it("is computed to a tenth, floored, so the surfaces' one-decimal display is real", () => {
    // $2 of $3 notional: 66.66…% -> 66.6 (it was a whole-percent 66, shown as "66.0%")
    expect(computeMarginHealthPct(2n * E6, 3n * E6, 1n * E6)).toBe(66.6);
    // just under the line stays under it: 99.99…% -> 99.9, never rounded up to 100
    expect(computeMarginHealthPct(999_999n, 1n * E6, 1n * E6)).toBe(99.9);
    expect(computeMarginHealthPct(1n * E6, 1n * E6, 1n * E6)).toBe(100);
  });
});

describe("the '% mgn' cell is floored (S8 review)", () => {
  it("a deleveraged covered leg just under 100% reads 99%, not 100%", () => {
    // Liq price solved on the reduced size (0.5) is clamped; health over the nominal 1 is 99.9.
    const d = describeLiqPrice({
      liqPriceE6: computeEngineLiqPrice(1n * E6, 999_000n, 500_000n, MM),
      positionSize: 1n * E6, capital: 999_000n, entryPriceE6: 1n * E6, effectiveSize: 500_000n,
      markPriceE6: 1n * E6, maintenanceMarginBps: MM, hasResolvedEntry: true,
    });
    expect(d.kind).toBe("covered");
    expect(d.marginHealthPct).toBe(99.9);
    expect(d.text).toBe("99% mgn");
  });
});
