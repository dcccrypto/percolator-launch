// @vitest-environment node
/**
 * The PnL share card's pure data model: live stats reuse the engine-formula
 * helpers (so the card matches the position row), a loss always shows "-$…", and
 * the Share-to-X text names the amount, direction and "Percolator Trade Devnet V2".
 */
import { describe, it, expect } from "vitest";
import {
  computePnlCardStats,
  formatSignedUsd,
  formatSignedPct,
  formatPriceUsd,
  buildShareTweet,
  buildShareToXUrl,
  isPnlPoolCapped,
  poolPayableCapacity,
  pnlCardBackgrounds,
  PNL_CARD_BACKGROUNDS_PROFIT,
  PNL_CARD_BACKGROUNDS_LOSS,
  type PnlCardData,
} from "@/lib/pnl-card";

const base: PnlCardData = {
  slab: "So11111111111111111111111111111111111111112",
  symbol: "HOKK",
  name: "Hokkaido Coin",
  logoUrl: null,
  decimals: 6,
  nominalSizeQ: 1_000_000_000n, // long
  effectiveSizeQ: 1_000_000_000n,
  entryE6: 400_000n, // $0.40
  initialMarginBps: 1000n,
  initialMarkE6: 400_000n,
};

describe("computePnlCardStats", () => {
  it("a long above entry is a profit; below entry is a loss; prices read through", () => {
    const up = computePnlCardStats(base, 500_000n); // mark $0.50 > entry $0.40
    expect(up.hasMark).toBe(true);
    expect(up.isProfit).toBe(true);
    expect(up.pnlUsd).toBeGreaterThan(0);
    expect(up.roePct).toBeGreaterThan(0);
    expect(up.avgEntryUsd).toBeCloseTo(0.4, 6);
    expect(up.avgExitUsd).toBeCloseTo(0.5, 6);
    expect(up.spentUsd).toBeGreaterThan(0);

    const down = computePnlCardStats(base, 300_000n); // mark $0.30 < entry
    expect(down.isProfit).toBe(false);
    expect(down.pnlUsd).toBeLessThan(0);
    expect(down.roePct).toBeLessThan(0);
  });

  it("falls back to the snapshot mark when the live store has nothing (0)", () => {
    const s = computePnlCardStats(base, 0n);
    expect(s.markE6).toBe(base.initialMarkE6);
    expect(s.hasMark).toBe(true);
  });

  it("a short gains when the mark falls below entry", () => {
    const short = { ...base, nominalSizeQ: -1_000_000_000n, effectiveSizeQ: -1_000_000_000n };
    expect(computePnlCardStats(short, 300_000n).isProfit).toBe(true);
    expect(computePnlCardStats(short, 500_000n).isProfit).toBe(false);
  });
});

describe("formatting", () => {
  it("signs USD and percent, and shows a loss as -$…", () => {
    expect(formatSignedUsd(378.96)).toBe("+$378.96");
    expect(formatSignedUsd(-12.4)).toBe("-$12.40");
    expect(formatSignedUsd(0)).toBe("$0.00");
    expect(formatSignedPct(0)).toBe("0.0%");
    expect(formatSignedPct(42.8)).toBe("+42.8%");
    expect(formatSignedPct(-9.05)).toBe("-9.1%");
  });
  it("prices scale with magnitude, never scientific", () => {
    expect(formatPriceUsd(35220)).toBe("$35.22K");
    expect(formatPriceUsd(1.5)).toBe("$1.50");
    expect(formatPriceUsd(0.000474)).not.toMatch(/e/i);
    expect(formatPriceUsd(0)).toBe("$0.00");
  });
});

describe("Share to X", () => {
  it("prebuilt tweet names direction, amount and the product", () => {
    const stats = computePnlCardStats(base, 500_000n);
    const t = buildShareTweet(base, stats);
    expect(t).toMatch(/I'm up \$/);
    expect(t).toContain("$HOKK");
    expect(t).toContain("Percolator Trade Devnet V2");

    const lossStats = computePnlCardStats(base, 300_000n);
    expect(buildShareTweet(base, lossStats)).toMatch(/I'm down \$/);
  });
  it("the intent URL carries the tweet text + the market link", () => {
    const stats = computePnlCardStats(base, 500_000n);
    const url = buildShareToXUrl(base, stats, "https://example.com");
    expect(url).toContain("https://twitter.com/intent/tweet?text=");
    expect(decodeURIComponent(url)).toContain("Percolator Trade Devnet V2");
    expect(decodeURIComponent(url)).toContain(`https://example.com/trade/${base.slab}`);
  });
});

describe("backgrounds", () => {
  it("profit and loss use separate, non-empty, non-overlapping scene sets", () => {
    expect(PNL_CARD_BACKGROUNDS_PROFIT.length).toBeGreaterThan(0);
    expect(PNL_CARD_BACKGROUNDS_LOSS.length).toBeGreaterThan(0);
    const overlap = PNL_CARD_BACKGROUNDS_PROFIT.filter((u) => PNL_CARD_BACKGROUNDS_LOSS.includes(u));
    expect(overlap).toEqual([]);
  });
  it("pnlCardBackgrounds selects the set by result", () => {
    expect(pnlCardBackgrounds(true)).toBe(PNL_CARD_BACKGROUNDS_PROFIT);
    expect(pnlCardBackgrounds(false)).toBe(PNL_CARD_BACKGROUNDS_LOSS);
  });
});

describe("tone, tweet and pool cap (credit/2907 corrections)", () => {
  it("tone is the exact sign of the shown PnL; exactly zero is flat", () => {
    expect(computePnlCardStats(base, 500_000n).tone).toBe("profit");
    expect(computePnlCardStats(base, 300_000n).tone).toBe("loss");
    expect(computePnlCardStats(base, 400_000n).tone).toBe("flat");
  });
  it("the tweet never contains a rocket, up, down or flat", () => {
    for (const m of [500_000n, 300_000n, 400_000n]) {
      expect(buildShareTweet(base, computePnlCardStats(base, m))).not.toContain("🚀");
    }
    expect(buildShareTweet(base, computePnlCardStats(base, 400_000n))).toMatch(/^I'm at breakeven \(\$0\.00, 0\.0%\)/);
  });
  it("isPnlPoolCapped matches the dock's rule (profit only, known capacity, strictly above)", () => {
    expect(isPnlPoolCapped(10n, 5n)).toBe(true);
    expect(isPnlPoolCapped(5n, 5n)).toBe(false);
    expect(isPnlPoolCapped(-10n, 5n)).toBe(false);
    expect(isPnlPoolCapped(10n, 0n)).toBe(false);
    expect(isPnlPoolCapped(10n, null)).toBe(false);
    expect(poolPayableCapacity(null, 7n)).toBe(7n);
    expect(poolPayableCapacity(3n, undefined)).toBe(3n);
  });
  it("a capped PnL shows the payable figure; ROE is on that figure; paper PnL is kept", () => {
    // Paper profit above $1 ($0.40 -> $0.44 on base); the pool can pay $1.
    const s = computePnlCardStats({ ...base, payableCapacityAtoms: 1_000_000n }, 440_000n);
    expect(s.isCapped).toBe(true);
    expect(s.pnlUsd).toBe(1);
    expect(s.paperPnlUsd).toBeGreaterThan(1);
    const uncapped = computePnlCardStats(base, 440_000n);
    expect(s.roePct).toBeLessThan(uncapped.roePct);
    expect(buildShareTweet(base, s)).toContain("I'm up $1.00 (");
  });
});
