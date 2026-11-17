// @vitest-environment node
/**
 * Edge/branch coverage for lib/pnl-card.ts: zero / negative / non-finite inputs,
 * long vs short, missing symbol / lot exponent, capped ROE variants, wording and
 * the display-rounding boundaries. Complements pnl-card.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  computePnlCardStats,
  formatSignedUsd,
  formatSignedPct,
  formatPriceUsd,
  buildShareTweet,
  pnlCardWording,
  PNL_CAPPED_NOTE,
  type PnlCardData,
} from "@/lib/pnl-card";

const base: PnlCardData = {
  slab: "So11111111111111111111111111111111111111112",
  symbol: "HOKK",
  name: "Hokkaido Coin",
  logoUrl: null,
  decimals: 6,
  nominalSizeQ: 1_000_000_000n,
  effectiveSizeQ: 1_000_000_000n,
  entryE6: 400_000n,
  initialMarginBps: 1000n,
  initialMarkE6: 400_000n,
};

describe("computePnlCardStats edge inputs", () => {
  it("no entry price: flat, zero spent, no NaN anywhere", () => {
    for (const entry of [0n, -5n]) {
      const s = computePnlCardStats({ ...base, entryE6: entry }, 500_000n);
      expect(s.tone).toBe("flat");
      expect(s.pnlUsd).toBe(0);
      expect(s.roePct).toBe(0);
      expect(s.spentUsd).toBe(0);
      expect(s.isProfit).toBe(true);
      for (const v of [s.pnlUsd, s.roePct, s.paperPnlUsd, s.spentUsd, s.avgEntryUsd, s.avgExitUsd]) {
        expect(Number.isNaN(v)).toBe(false);
        expect(Object.is(v, -0)).toBe(false);
      }
    }
  });

  it("no mark at all (live 0/negative and snapshot 0): hasMark false, flat", () => {
    const d = { ...base, initialMarkE6: 0n };
    for (const m of [0n, -1n]) {
      const s = computePnlCardStats(d, m);
      expect(s.hasMark).toBe(false);
      expect(s.tone).toBe("flat");
      expect(s.pnlUsd).toBe(0);
      expect(s.avgExitUsd).toBe(0);
    }
  });

  it("zero size: nothing at risk, flat, zero spent", () => {
    const s = computePnlCardStats({ ...base, effectiveSizeQ: 0n, nominalSizeQ: 0n }, 500_000n);
    expect(s.tone).toBe("flat");
    expect(s.spentUsd).toBe(0);
    expect(s.roePct).toBe(0);
  });

  it("non-finite USD conversion collapses to 0 (decimals that overflow the divisor)", () => {
    // 10 ** -400 === 0 -> atoms / 0 = Infinity -> must not reach the card.
    const s = computePnlCardStats({ ...base, decimals: -400 }, 500_000n);
    expect(s.pnlUsd).toBe(0);
    expect(s.paperPnlUsd).toBe(0);
    expect(s.spentUsd).toBe(0);
    expect(Number.isFinite(s.avgEntryUsd)).toBe(true);
  });

  it("short loses above entry (loss tone) and gains below it (profit tone)", () => {
    const short = { ...base, nominalSizeQ: -1_000_000_000n, effectiveSizeQ: -1_000_000_000n };
    const up = computePnlCardStats(short, 500_000n);
    expect(up.tone).toBe("loss");
    expect(up.pnlUsd).toBeLessThan(0);
    expect(up.roePct).toBeLessThan(0);
    expect(up.spentUsd).toBeGreaterThan(0); // margin is on |size|
    const down = computePnlCardStats(short, 300_000n);
    expect(down.tone).toBe("profit");
    expect(down.pnlUsd).toBeGreaterThan(0);
  });

  it("lot exponent scales the displayed prices only when set", () => {
    const plain = computePnlCardStats(base, 500_000n);
    const lot = computePnlCardStats({ ...base, lotExp: 3 }, 500_000n);
    expect(lot.avgEntryUsd).not.toBe(plain.avgEntryUsd);
    expect(lot.avgExitUsd).not.toBe(plain.avgExitUsd);
    expect(computePnlCardStats({ ...base, lotExp: 0 }, 500_000n).avgEntryUsd).toBe(plain.avgEntryUsd);
  });

  it("capped PnL with an explicit capital uses that as the ROE base", () => {
    const capped = { ...base, payableCapacityAtoms: 1_000_000n };
    const byMargin = computePnlCardStats(capped, 440_000n);
    const byCapital = computePnlCardStats({ ...capped, capital: 2_000_000n }, 440_000n);
    expect(byCapital.isCapped).toBe(true);
    expect(byCapital.pnlUsd).toBe(1);
    // $1 on a $2 capital = 50%.
    expect(byCapital.roePct).toBeCloseTo(50, 6);
    expect(byCapital.roePct).not.toBeCloseTo(byMargin.roePct, 3);
  });

  it("capped with zero margin base yields ROE 0, not NaN/Infinity", () => {
    // Tiny size -> initial margin rounds to 0 atoms while paper PnL is still > cap of 0? use cap=1.
    const tiny = { ...base, effectiveSizeQ: 1n, nominalSizeQ: 1n, payableCapacityAtoms: 1n, initialMarginBps: 0n };
    const s = computePnlCardStats(tiny, 100_000_000n);
    expect(Number.isFinite(s.roePct)).toBe(true);
    expect(Object.is(s.roePct, NaN)).toBe(false);
  });

  it("an unknown or non-binding capacity is not a cap", () => {
    expect(computePnlCardStats({ ...base, payableCapacityAtoms: null }, 440_000n).isCapped).toBe(false);
    expect(computePnlCardStats({ ...base, payableCapacityAtoms: 10n ** 12n }, 440_000n).isCapped).toBe(false);
  });
});

describe("pnlCardWording", () => {
  it("maps every tone", () => {
    expect(pnlCardWording("profit")).toEqual({ label: "PROFIT", headline: "YOU'VE MADE", arrow: "▲" });
    expect(pnlCardWording("loss")).toEqual({ label: "LOSS", headline: "YOU'RE DOWN", arrow: "▼" });
    expect(pnlCardWording("flat")).toEqual({ label: "BREAKEVEN", headline: "YOU'RE AT", arrow: "" });
  });
});

describe("display rounding boundaries", () => {
  it("formatSignedUsd: sub-cent amounts round at the 2dp boundary; sign follows the input", () => {
    expect(formatSignedUsd(0.004)).toBe("+$0.00");
    expect(formatSignedUsd(0.005)).toMatch(/^\+\$0\.0[01]$/);
    expect(formatSignedUsd(-0.004)).toBe("-$0.00");
    expect(formatSignedUsd(1234.5)).toBe("+$1,234.50");
  });
  it("formatSignedPct: 1dp, boundary and sign", () => {
    expect(formatSignedPct(0.04)).toBe("+0.0%");
    expect(formatSignedPct(-0.04)).toBe("-0.0%");
    expect(formatSignedPct(99.95)).toMatch(/^\+(99\.9|100\.0)%$/);
    expect(formatSignedPct(-1234.56)).toBe("-1234.6%");
  });
  it("formatPriceUsd: every magnitude band and its boundaries", () => {
    expect(formatPriceUsd(NaN)).toBe("$0.00");
    expect(formatPriceUsd(Infinity)).toBe("$0.00");
    expect(formatPriceUsd(-3)).toBe("$0.00");
    expect(formatPriceUsd(1000)).toBe("$1K");
    expect(formatPriceUsd(999.999)).toBe("$1,000.00");
    expect(formatPriceUsd(1)).toBe("$1.00");
    expect(formatPriceUsd(0.99999)).toBe("$1.0000");
    expect(formatPriceUsd(0.01)).toBe("$0.0100");
    expect(formatPriceUsd(0.0099)).toBe("$0.0099");
    expect(formatPriceUsd(0.000474)).toBe("$0.000474");
    expect(formatPriceUsd(0.000000001)).toBe("$0.0");
  });
});

describe("buildShareTweet variants", () => {
  const stats = (over: Partial<ReturnType<typeof computePnlCardStats>>) => ({
    ...computePnlCardStats(base, 500_000n),
    ...over,
  });
  it("missing symbol falls back to 'this market'", () => {
    const t = buildShareTweet({ ...base, symbol: "" }, stats({}));
    expect(t).toContain("on this market on Percolator Trade Devnet V2");
    expect(t).not.toContain("$HOKK");
  });
  it("a capped profit carries the capped note; a capped note never appears on a loss", () => {
    const profit = buildShareTweet(base, stats({ tone: "profit", isCapped: true }));
    expect(profit).toContain(`, ${PNL_CAPPED_NOTE})`);
    const loss = buildShareTweet(base, stats({ tone: "loss", pnlUsd: -2, roePct: -5, isCapped: true }));
    expect(loss).toMatch(/^I'm down \$2\.00 \(-5\.0%\) on/);
    expect(loss).not.toContain(PNL_CAPPED_NOTE);
  });
  it("amount in a loss tweet has no sign (the words carry direction)", () => {
    const t = buildShareTweet(base, stats({ tone: "loss", pnlUsd: -12.4, roePct: -9.1 }));
    expect(t).toContain("I'm down $12.40 (-9.1%)");
  });
});
