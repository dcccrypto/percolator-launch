/**
 * #2987 corrections: the liquidation price every surface shows must be the engine's,
 * and the site-wide alert's tiers must not fire for an ordinary freshly opened position.
 *
 * The engine reference below mirrors percolator v16.rs (35ddd692)
 * compute_account_health_cert_with_price_override + margin_requirement: a leg is
 * liquidatable when equity = capital + q*(P - E) is below ceil(|q|*P * mm / 1e4)
 * (min_nonzero_mm_req floor and target-lag penalty are 0 here).
 */
import { describe, it, expect } from "vitest";
import { computeLiqPrice as sdkComputeLiqPrice } from "@percolatorct/sdk";
import { computeLiqPrice, computePreTradeLiqPrice } from "@/lib/trading";
import {
  computeEngineLiqPrice,
  computeMarginCushion,
  severityFromCushion,
} from "@/lib/liquidation-risk";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";

const E6 = 1_000_000n;

/** Engine maintenance check at price P (collateral atoms, e6 size/price). */
function engineLiquidatable(q: bigint, entry: bigint, capital: bigint, price: bigint, mmBps: bigint): boolean {
  const absQ = q < 0n ? -q : q;
  // equity and requirement in e6-scaled collateral (x 1e6) to stay exact
  const equityE6 = capital * E6 + q * (price - entry);
  const notionalE6 = absQ * price;
  const mmReqE6 = (notionalE6 * mmBps + 9_999n) / 10_000n;
  return equityE6 < mmReqE6;
}

const ENTRY = 100n * E6; // $100
const ONE = 1n * E6; // 1 unit
const cases: Array<[string, bigint, bigint, bigint]> = [
  // name, signed size, capital (collateral atoms, 6dp), mm bps
  ["10x long, mm 5%", ONE, 10n * E6, 500n],
  ["5x long, mm 5%", ONE, 20n * E6, 500n],
  ["10x short, mm 5%", -ONE, 10n * E6, 500n],
  ["5x short, mm 5%", -ONE, 20n * E6, 500n],
  ["3x long, mm 16.66%", 3n * ONE, 100n * E6, 1666n],
  ["3x short, mm 16.66%", -3n * ONE, 100n * E6, 1666n],
];

describe("engine-consistent liquidation price", () => {
  it.each(cases)("%s: liquidatable exactly past the shown price, not before", (_n, q, capital, mm) => {
    const liq = computeLiqPrice(ENTRY, capital, q, mm);
    expect(liq).toBeGreaterThan(0n);
    // At the shown price the engine does not liquidate yet; one tick further it does.
    const beyond = q > 0n ? liq - 1n : liq + 1n;
    expect(engineLiquidatable(q, ENTRY, capital, liq, mm)).toBe(false);
    expect(engineLiquidatable(q, ENTRY, capital, beyond, mm)).toBe(true);
  });

  it("lib/trading's computeLiqPrice is the engine one, not the SDK's", () => {
    expect(computeLiqPrice).toBe(computeEngineLiqPrice);
    // 10x long at mm 5%: engine 94.7368, SDK 90.4762.
    expect(computeLiqPrice(ENTRY, 10n * E6, ONE, 500n)).toBe(94_736_843n);
    expect(sdkComputeLiqPrice(ENTRY, 10n * E6, ONE, 500n)).toBe(90_476_191n);
  });

  it("a position the engine can liquidate now reads 0% from liquidation (SDK model read ~4.5%)", () => {
    // 10x long, mark at the engine's boundary - 1 tick
    const liq = computeLiqPrice(ENTRY, 10n * E6, ONE, 500n);
    const mark = liq - 1n;
    expect(engineLiquidatable(ONE, ENTRY, 10n * E6, mark, 500n)).toBe(true);
    expect(computeLiquidationDistancePct(ONE, mark, liq)).toBe(0);
    const sdkLiq = sdkComputeLiqPrice(ENTRY, 10n * E6, ONE, 500n);
    expect(computeLiquidationDistancePct(ONE, mark, sdkLiq)).toBeGreaterThan(4);
  });

  it("a fresh 10x long reads 5.26% from liquidation at entry, not 9.52%", () => {
    const liq = computeLiqPrice(ENTRY, 10n * E6, ONE, 500n);
    expect(computeLiquidationDistancePct(ONE, ENTRY, liq)).toBeCloseTo(5.26, 2);
  });

  it("a long with collateral >= notional at entry has no liquidation price", () => {
    expect(computeLiqPrice(ENTRY, 100n * E6, ONE, 500n)).toBe(0n);
    expect(computeLiqPrice(ENTRY, 99n * E6, ONE, 500n)).toBeGreaterThan(0n);
  });

  it("the pre-trade estimate uses the same model", () => {
    const pre = computePreTradeLiqPrice(ENTRY, 10n * E6, ONE, 500n, 0n, "long");
    expect(pre).toBe(computeLiqPrice(ENTRY, 10n * E6, ONE, 500n));
  });
});

describe("margin-cushion tiers", () => {
  const base = { entryPriceE6: ENTRY, maintenanceMarginBps: 500n, initialMarginBps: 1000n };

  it("no freshly opened position alerts, whatever its leverage up to the market max", () => {
    for (const lev of [2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]) {
      for (const q of [ONE, -ONE]) {
        const c = computeMarginCushion({ ...base, positionSize: q, capital: (100n * E6) / lev, markPriceE6: ENTRY });
        expect(c).not.toBeNull();
        expect(severityFromCushion(c!)).toBe("safe");
      }
    }
  });

  it("warns once half the way to the engine liquidation price is gone; danger at three quarters", () => {
    for (const [q, capital] of [[ONE, 10n * E6], [ONE, 20n * E6], [-ONE, 10n * E6], [-ONE, 50n * E6]] as const) {
      const liq = computeLiqPrice(ENTRY, capital, q, 500n);
      const at = (frac: number) => {
        // price `frac` of the way from entry to the engine's liquidation price
        const p = ENTRY + ((liq - ENTRY) * BigInt(Math.round(frac * 1000))) / 1000n;
        return severityFromCushion(computeMarginCushion({ ...base, positionSize: q, capital, markPriceE6: p })!);
      };
      expect(at(0.4)).toBe("safe");
      expect(at(0.55)).toBe("warning");
      expect(at(0.8)).toBe("danger");
      expect(at(1.0)).toBe("danger");
    }
  });

  it("with an unknown entry (entry = mark) it is judged against the initial-margin line", () => {
    // entry == mark, equity 7% of notional at mm 5 / im 10 -> cushion 0.4 -> warning
    const c = computeMarginCushion({ ...base, positionSize: ONE, capital: 7n * E6, markPriceE6: ENTRY });
    expect(c).toBeCloseTo(0.4, 5);
    expect(severityFromCushion(c!)).toBe("warning");
  });

  it("missing im falls back to 2 x mm; no mark is not measurable", () => {
    const a = computeMarginCushion({ ...base, initialMarginBps: null, positionSize: ONE, capital: 10n * E6, markPriceE6: ENTRY });
    expect(a).toBeCloseTo(1, 5);
    expect(computeMarginCushion({ ...base, positionSize: ONE, capital: 10n * E6, markPriceE6: 0n })).toBeNull();
  });
});

describe("usePortfolio's tier helpers (the poll's count, the sort, the /portfolio cards)", () => {
  // Lazy import: usePortfolio pulls in the app's module graph.
  const pos = (mark: bigint, capital = 10n * E6, size = ONE) =>
    ({
      account: { positionSize: size, capital },
      effectiveEntryPrice: ENTRY, effectiveSize: size, oraclePriceE6: mark,
      maintenanceMarginBps: 500n, initialMarginBps: 1000n,
      liquidationPriceE6: computeLiqPrice(ENTRY, capital, size, 500n),
    }) as any;

  it("liveLiquidationSeverity: fresh 5x/10x safe; tiers follow the margin cushion at the mark", async () => {
    const { liveLiquidationSeverity } = await import("@/hooks/usePortfolio");
    expect(liveLiquidationSeverity(pos(ENTRY), null)).toBe("safe"); // 10x at entry
    expect(liveLiquidationSeverity(pos(ENTRY, 20n * E6), null)).toBe("safe"); // 5x at entry
    expect(liveLiquidationSeverity(pos(97n * E6), null)).toBe("warning"); // the poll's own mark
    expect(liveLiquidationSeverity(pos(ENTRY), 95_800_000n)).toBe("danger"); // a live mark wins
  });

  it("getLiquidationSeverityForState uses the cushion when given one", async () => {
    const { getLiquidationSeverityForState } = await import("@/hooks/usePortfolio");
    // 9.52% from the SDK price would be "danger" on the flat tiers; a fresh 10x is safe.
    expect(getLiquidationSeverityForState({ kind: "liquidatable", distancePct: 5.26 }, 1)).toBe("safe");
    expect(getLiquidationSeverityForState({ kind: "liquidatable", distancePct: 2.3 }, 0.44)).toBe("warning");
  });
});
