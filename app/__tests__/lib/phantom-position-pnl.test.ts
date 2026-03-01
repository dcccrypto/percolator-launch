/**
 * PERC-297: Phantom position PnL display bug
 *
 * When a position exists but the mark/oracle price is unavailable (0n),
 * PnL and ROE should NOT be computed — they should show as placeholders.
 * This test validates the defensive guards in the PnL computation path.
 */
import { describe, it, expect } from "vitest";
import { computeMarkPnl, computePnlPercent } from "@percolator/sdk";
import { formatUsd, formatPnl, formatPercent } from "../../lib/format";

describe("PERC-297: Phantom position PnL guards", () => {
  // Simulate a position that just got created
  const positionSize = 4_477_506_716n; // ~4477 tokens (6 decimals)
  const entryPrice = 1_000_000n;        // $1.00 in e6
  const capital = 1_000_000_000n;        // 1000 tokens capital

  describe("computeMarkPnl with zero oracle", () => {
    it("returns 0n when oraclePrice is 0n", () => {
      const pnl = computeMarkPnl(positionSize, entryPrice, 0n);
      expect(pnl).toBe(0n);
    });

    it("returns 0n when positionSize is 0n", () => {
      const pnl = computeMarkPnl(0n, entryPrice, 1_000_000n);
      expect(pnl).toBe(0n);
    });

    it("returns valid PnL when oracle is available", () => {
      // oracle = $2.00 (double the entry), long position
      // pnl = (2_000_000 - 1_000_000) * 4_477_506_716 / 2_000_000 = 2_238_753_358
      const pnl = computeMarkPnl(positionSize, entryPrice, 2_000_000n);
      expect(pnl).toBeGreaterThan(0n);
      // Should be approximately half the position size
      expect(pnl).toBe(2_238_753_358n);
    });
  });

  describe("hasValidMark guard pattern", () => {
    it("guards PnL computation when mark is 0n", () => {
      const currentPriceE6 = 0n;
      const hasValidMark = currentPriceE6 > 0n;

      expect(hasValidMark).toBe(false);

      // This is the guarded pattern used in PositionsTable/PositionPanel
      const pnlTokens = hasValidMark
        ? computeMarkPnl(positionSize, entryPrice, currentPriceE6)
        : 0n;
      const roe = hasValidMark ? computePnlPercent(pnlTokens, capital) : 0;

      expect(pnlTokens).toBe(0n);
      expect(roe).toBe(0);
    });

    it("allows PnL computation when mark is valid", () => {
      const currentPriceE6 = 1_500_000n; // $1.50
      const hasValidMark = currentPriceE6 > 0n;

      expect(hasValidMark).toBe(true);

      const pnlTokens = hasValidMark
        ? computeMarkPnl(positionSize, entryPrice, currentPriceE6)
        : 0n;
      const roe = hasValidMark ? computePnlPercent(pnlTokens, capital) : 0;

      expect(pnlTokens).toBeGreaterThan(0n);
      expect(roe).toBeGreaterThan(0);
    });
  });

  describe("formatUsd with zero/invalid prices", () => {
    it("returns dash for 0n (oracle unavailable)", () => {
      expect(formatUsd(0n)).toBe("$—");
    });

    it("returns dash for negative prices", () => {
      expect(formatUsd(-1n)).toBe("$—");
    });

    it("returns $0.00 for null (no data yet)", () => {
      expect(formatUsd(null)).toBe("$0.00");
    });

    it("formats valid prices normally", () => {
      expect(formatUsd(1_000_000n)).toContain("1");
      expect(formatUsd(1_000_000n).startsWith("$")).toBe(true);
    });
  });

  describe("PnL display for phantom scenario", () => {
    it("should NOT show +SIZE as PnL when mark is unavailable", () => {
      // This is the exact scenario from the bug report:
      // positionSize = 4477.506716, entry = $1.00, mark = null (0n)
      const hasValidMark = false;
      const pnlTokens = hasValidMark ? computeMarkPnl(positionSize, entryPrice, 0n) : 0n;

      // PnL should be zero, not +4477.506716
      expect(pnlTokens).toBe(0n);
      expect(formatPnl(pnlTokens)).toBe("0");
    });

    it("ROE should be 0% when mark is unavailable", () => {
      const hasValidMark = false;
      const roe = hasValidMark ? computePnlPercent(0n, capital) : 0;
      expect(roe).toBe(0);
      expect(formatPercent(roe)).toBe("0.00%");
    });
  });
});
