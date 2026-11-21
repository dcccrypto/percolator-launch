/**
 * computeEnginePreTradeLiqPrice vs the engine maintenance formula.
 *
 * Engine (percolator feat/v22-engine-rc23-2026-10-22, src/v16.rs):
 *   health_requirements_from_notional_and_target_lag :4296 (maintenance_req = ceil(notional * mm / 1e4))
 *   maintenance_requirement_for_notional             :5329
 * liquidatable when equity = C + q*(P-E) < |q|*P*mm  =>
 *   long : P_liq = (E - C/q) / (1 - mm)      short: P_liq = (E + C/|q|) / (1 + mm)
 *
 * Regression: margin === 0n used to return 0n, the "no liquidation price" signal, for a position
 * that is liquidatable immediately.
 */
import { describe, it, expect } from "vitest";
import { computeEnginePreTradeLiqPrice } from "@/lib/liquidation-risk";

const E6 = 1_000_000n;
const ORACLE = 100n * E6;
const Q = 1_000_000n;
const MM = 500n;

// Independent re-derivation in floating point (e6 price).
function formula(entry: number, capital: number, q: number, mm: number, side: "long" | "short") {
  const c = capital / q; // capital atoms (e6) per base unit (q e6)
  return side === "long" ? (entry - c * 1e6) / (1 - mm) : (entry + c * 1e6) / (1 + mm);
}

describe("computeEnginePreTradeLiqPrice vs engine formula", () => {
  const margins = [0n, 1n, 5n * E6, 10n * E6, 50n * E6, 94n * E6];
  for (const side of ["long", "short"] as const) {
    for (const margin of margins) {
      it(`${side}, margin ${margin}`, () => {
        const got = computeEnginePreTradeLiqPrice(ORACLE, margin, Q, MM, 0n, side);
        const want = formula(Number(ORACLE), Number(margin), Number(Q), 0.05, side);
        expect(Math.abs(Number(got) - want)).toBeLessThanOrEqual(2);
        expect(got).toBeGreaterThan(0n);
      });
    }
  }

  it("zero margin long: liquidatable at once, liq price is above the entry (not the 0n 'covered' signal)", () => {
    const got = computeEnginePreTradeLiqPrice(ORACLE, 0n, Q, MM, 0n, "long");
    expect(got).toBeGreaterThan(ORACLE);
    expect(got).toBe(105_263_158n);
  });

  it("zero margin short: below the entry", () => {
    const got = computeEnginePreTradeLiqPrice(ORACLE, 0n, Q, MM, 0n, "short");
    expect(got).toBeLessThan(ORACLE);
    expect(got).toBe(95_238_095n);
  });

  it("still 0n for no oracle or no size", () => {
    expect(computeEnginePreTradeLiqPrice(0n, E6, Q, MM, 0n, "long")).toBe(0n);
    expect(computeEnginePreTradeLiqPrice(ORACLE, E6, 0n, MM, 0n, "long")).toBe(0n);
  });
});
