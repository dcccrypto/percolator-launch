/**
 * estimateEntryFromPnl — unit-correctness regression tests.
 *
 * The portfolio's on-chain `pnl` is COLLATERAL ATOMS, not the coin-native
 * value `computeMarkPnl` returns. (SDK types: `capital` = "Collateral capital
 * in atoms", `pnl` = "Unrealised P&L in atoms" — same unit. Decisively: a
 * portfolio holds 16 LEG slots each with its own `assetIndex` but only ONE
 * scalar `pnl`; a single number summing P&L across different assets can only
 * be in a common unit.)
 *
 * The old implementation inverted the coin-margined relation instead, which
 * overstated the entry offset by ~the price. These tests pin the correct
 * relation:  pnl = absPos * (mark - entry) / 1e6   [sign flips for shorts]
 */
import { describe, it, expect } from "vitest";
import { estimateEntryFromPnl } from "@/lib/trading";

const E6 = 1_000_000n;
/** Collateral PnL for a position, in atoms — the on-chain `pnl` semantics. */
function collateralPnl(sizeQ: bigint, entryE6: bigint, markE6: bigint): bigint {
  return (sizeQ * (markE6 - entryE6)) / E6; // sizeQ is signed: shorts flip naturally
}

describe("estimateEntryFromPnl (collateral-denominated pnl)", () => {
  it("recovers the true entry for a WINNING long", () => {
    const size = 1_000_000n;      // 1 SOL
    const entry = 75_000_000n;    // $75
    const mark = 81_170_000n;     // $81.17
    const pnl = collateralPnl(size, entry, mark); // +6_170_000 atoms = +$6.17
    expect(pnl).toBe(6_170_000n);
    expect(estimateEntryFromPnl(size, pnl, mark)).toBe(entry);
  });

  it("recovers the true entry for a LOSING long (used to render $581.99)", () => {
    const size = 1_000_000n;
    const entry = 88_000_000n;    // $88 — underwater
    const mark = 81_170_000n;
    const pnl = collateralPnl(size, entry, mark); // negative
    expect(pnl).toBeLessThan(0n);
    expect(estimateEntryFromPnl(size, pnl, mark)).toBe(entry);
  });

  it("recovers the true entry for a SHORT (sign handling)", () => {
    const size = -2_000_000n;     // short 2 SOL
    const entry = 90_000_000n;
    const mark = 81_170_000n;
    const pnl = collateralPnl(size, entry, mark); // short profits as price falls
    expect(pnl).toBeGreaterThan(0n);
    expect(estimateEntryFromPnl(size, pnl, mark)).toBe(entry);
  });

  it("recovers the entry on a SUB-DOLLAR token (where the old bug inverted hardest)", () => {
    const size = 1_000_000_000n;  // 1000 PENGU (6dp)
    const entry = 5_000n;         // $0.005
    const mark = 5_954n;          // $0.005954
    const pnl = collateralPnl(size, entry, mark);
    expect(estimateEntryFromPnl(size, pnl, mark)).toBe(entry);
  });

  it("a flat position (pnl = 0) returns the mark", () => {
    expect(estimateEntryFromPnl(1_000_000n, 0n, 81_170_000n)).toBe(81_170_000n);
  });

  it("degenerate inputs fall back to the mark rather than throwing", () => {
    expect(estimateEntryFromPnl(0n, 123n, 81_170_000n)).toBe(81_170_000n);
    expect(estimateEntryFromPnl(1_000_000n, 123n, 0n)).toBe(0n);
  });

  it("never returns a negative entry (clamps to mark)", () => {
    // An absurd pnl (e.g. a sentinel leaking in) must not produce a negative price.
    const entry = estimateEntryFromPnl(1_000_000n, 10n ** 18n, 81_170_000n);
    expect(entry).toBeGreaterThan(0n);
  });
});
