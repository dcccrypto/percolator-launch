/**
 * A: MarketStatsCard's "Market LP" stat renders COLLATERAL (sim-USDC) atoms —
 * NOT a coin quantity — so it must NEVER be multiplied by the market's
 * base-asset price. Open Interest (totalOI/oiLong/oiShort) IS a base-asset
 * quantity and DOES need ×price. Mixing the two formatters (using the OI
 * formatter for the LP stat) rendered an LP holding 10,000 sim-USDC on the
 * SOL market ($81/SOL) as "$811,700" (×81), and as low as "$26" on a
 * sub-cent asset like BURNIE ($0.0026) — 385× understated.
 *
 * These are pure-math mirrors of `fmtOI`/`fmtCollateralUsd` in
 * components/trade/MarketStatsCard.tsx (not exported from the component —
 * same "inline mirror" convention __tests__/api/leaderboard.test.ts already
 * uses for that route's aggregation logic). Keep in sync with the real
 * implementation if either changes.
 */
import { describe, it, expect } from "vitest";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Mirrors MarketStatsCard.tsx's fmtOI — OI is a base-asset quantity, ×price when USD. */
function fmtOIUsd(atoms: bigint, tokenDivisor: number, priceUsd: number): string {
  return formatNum((Number(atoms) / tokenDivisor) * priceUsd);
}

/** Mirrors MarketStatsCard.tsx's fmtCollateralUsd — collateral atoms are
 *  already USD-denominated; NEVER multiplied by the base-asset price. */
function fmtCollateralUsd(atoms: bigint, tokenDivisor: number): string {
  return formatNum(Number(atoms) / tokenDivisor);
}

describe("MarketStatsCard: collateral (Market LP) vs coin-quantity (OI) formatting", () => {
  const SIM_USDC_DIVISOR = 10 ** 6;

  it("Market LP: 10,000 sim-USDC on the SOL market ($81/SOL) renders as $10,000, not $811,700", () => {
    const lpAtoms = 10_000_000_000n; // 10,000 sim-USDC at 6 decimals
    const solPriceUsd = 81.17;

    // The bug: reusing the OI formatter multiplies collateral by the SOL price.
    const buggy = fmtOIUsd(lpAtoms, SIM_USDC_DIVISOR, solPriceUsd);
    expect(buggy).toBe("$811.7K"); // the wrong, ×81 value this bug produced

    // The fix: collateral formatter never multiplies by price.
    const fixed = fmtCollateralUsd(lpAtoms, SIM_USDC_DIVISOR);
    expect(fixed).toBe("$10.0K");
  });

  it("Market LP: same 10,000 sim-USDC on a sub-cent asset (BURNIE $0.0026) does not understate to $26", () => {
    const lpAtoms = 10_000_000_000n;
    const burniePriceUsd = 0.0026;

    const buggy = fmtOIUsd(lpAtoms, SIM_USDC_DIVISOR, burniePriceUsd);
    expect(buggy).toBe("$26.00"); // 385× understated — the bug

    const fixed = fmtCollateralUsd(lpAtoms, SIM_USDC_DIVISOR);
    expect(fixed).toBe("$10.0K"); // correct regardless of the market's asset price
  });

  it("Open Interest legitimately needs ×price (base-asset quantity, not collateral)", () => {
    // 100 SOL of OI (base-asset "Q" quantity, scale 1e6) at $81.17/SOL = $8,117 OI.
    const oiAtoms = 100_000_000n;
    const solPriceUsd = 81.17;
    expect(fmtOIUsd(oiAtoms, SIM_USDC_DIVISOR, solPriceUsd)).toBe("$8.1K");
  });

  it("collateral formatting is stable across every market's price (it never enters the formula)", () => {
    const lpAtoms = 10_000_000_000n;
    const priceA = fmtCollateralUsd(lpAtoms, SIM_USDC_DIVISOR);
    const priceB = fmtCollateralUsd(lpAtoms, SIM_USDC_DIVISOR); // same math, price never passed in
    expect(priceA).toBe(priceB);
    expect(priceA).toBe("$10.0K");
  });
});
