/**
 * PoC + regression — the order ticket's fresh-open liquidation PREVIEW must price
 * against the full cross-margined account capital, not just the order's margin.
 *
 * Percolator v17 is cross-margined (withdraw is blocked while any leg is open), so
 * the whole account backs a position. OrderTicket's scale-in branch already prices
 * liq with `capital` (matching PositionsDock / useLiqPrice), but the fresh-open
 * branch (existingPositionSize === 0n) used computePreTradeLiqPrice against only
 * `marginNative`. Whenever capital > order margin, that understates liquidation
 * distance — the confirm modal shows a scarier (closer) liq price than the real
 * on-chain one, and it visibly jumps once the position opens and recomputes on
 * full capital.
 *
 * This uses the real SDK/app math to show the margin-only preview differs from the
 * capital-based value, and that the capital-based value is the sane one.
 */
import { describe, it, expect } from "vitest";
import { computePreTradeLiqPrice, computeLiqPrice } from "@percolatorct/sdk";
import { computeEstimatedEntryPrice } from "@/lib/trading";

const oracleE6 = 100_000_000n;          // $100
const capital = 1_000_000_000n;         // 1000 USDC total account capital
const marginNative = 100_000_000n;      // 100 USDC reserved for THIS order
const positionSize = 5_000_000n;        // 5 units (≈ $500 notional, 5x on 100 margin)
const mmBps = 500n;                      // 5% maintenance margin
const feeBps = 30n;

describe("order ticket fresh-open liq preview", () => {
  it("margin-only preview shows a scary liq for a position that's safer at full capital (the bug)", () => {
    const estEntry = computeEstimatedEntryPrice(oracleE6, feeBps, "long");

    // OLD fresh-open branch: prices against just the order's margin.
    const marginOnlyLiq = computePreTradeLiqPrice(oracleE6, marginNative, positionSize, mmBps, feeBps, "long");
    // FIXED: full account capital backs the position (cross-margin) — matches the
    // scale-in branch and PositionsDock.
    const capitalLiq = computeLiqPrice(estEntry, capital, positionSize, mmBps);

    // The preview shows a real, scary liq price...
    expect(marginOnlyLiq).toBeGreaterThan(0n);
    // ...while the true cross-margin liq is either UNLIQUIDATABLE (0n = "∞", as in
    // this 10x-capital case) or strictly farther from entry (lower, for a long).
    expect(capitalLiq === 0n || capitalLiq < marginOnlyLiq).toBe(true);
    // The preview materially disagrees with the reality the position will show once open.
    expect(marginOnlyLiq).not.toBe(capitalLiq);
  });

  it("when order margin equals capital, the two agree (no false positive)", () => {
    const estEntry = computeEstimatedEntryPrice(oracleE6, feeBps, "long");
    const marginOnlyLiq = computePreTradeLiqPrice(oracleE6, capital, positionSize, mmBps, feeBps, "long");
    const capitalLiq = computeLiqPrice(estEntry, capital, positionSize, mmBps);
    // Same backing → liq prices are close (fee modeling aside).
    const diff = marginOnlyLiq > capitalLiq ? marginOnlyLiq - capitalLiq : capitalLiq - marginOnlyLiq;
    expect(diff).toBeLessThan(oracleE6 / 100n); // within ~$1
  });
});
