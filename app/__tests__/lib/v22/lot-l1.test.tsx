/**
 * v2.2 QA L-1: the three lot surfaces that kept lot markets refused, each with its evidence.
 *  - keeper-mark-scaling: the keeper pushes price x 10^lot_exp (live 2026-10-11, __tests__/live/v22-lot-marks-live.test.ts:
 *    8 keeper-priced markets within 1.6% of Jupiter x 10^lot_exp, the unscaled control off by >= 10x). Pinned here: the
 *    per-lot -> per-token conversion the ticket uses, on the marks read on chain that day.
 *  - indexer-candles-trades: the v2.2 indexer draft (#218 827aa7f) has no lot handling and stores chain values (per lot);
 *    the app's trade-history / candle formatting converts per-lot rows to per-token.
 *  - trade-stats-panel: TradeStatsPanel withholds volume on v2.2 until a lot-aware indexer is attested.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { formatStatValue } from "@/lib/format";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { formatLotPriceE6, tokenQToQ, lotPriceToTokenE6, tokenPriceToLotE6, tokenUsdOfLotUsd, POS_SCALE_V22 } from "@/lib/v22/lot";
import { formatPrice, formatSize } from "@/components/trade/TradeHistoryTable";
import { gateVolumeForV22, volumeDisplay, VOLUME_UNVERIFIED_NOTE } from "@/lib/trade-stats-display";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";
import type { TraderStatsResponse } from "@/hooks/useTraderStats";

afterEach(() => __setDevnetV22ForTest(null));

describe("keeper-mark-scaling: keeper pushes price x 10^lot_exp (live 2026-10-11)", () => {
  // Per-LOT marks read on chain 2026-10-11 (keeper oracle-keeper 9e56eb5) with Jupiter's per-token USD that minute.
  const live = [
    { sym: "CHILLHOUSE", k: 4, markE6: 11_960_000n, jupUsd: 0.0011845 },
    { sym: "JUP", k: 2, markE6: 36_743_900n, jupUsd: 0.3655906 },
    { sym: "PENGU", k: 4, markE6: 81_250_000n, jupUsd: 0.008133 },
    { sym: "SOL", k: 0, markE6: 109_442_327n, jupUsd: 109.4107 },
  ];
  it.each(live)("$sym: the ticket's per-token price matches the token price; per-lot = per-token x 10^k", ({ k, markE6, jupUsd }) => {
    const perToken = lotPriceToTokenE6(markE6, k);
    expect(Math.abs(Number(perToken) / (jupUsd * 1e6) - 1)).toBeLessThan(0.02);
    expect(tokenPriceToLotE6(perToken, k)).toBe(perToken * 10n ** BigInt(k));
    expect(tokenUsdOfLotUsd(Number(markE6) / 1e6, k)).toBeCloseTo(Number(markE6) / 1e6 / 10 ** k, 12);
  });
  it("CHILLHOUSE: 100,000 tokens is 10 lots (the ticket's lotOrderQ quantises this); the display is per token", () => {
    const { q, remainderTokenQ } = tokenQToQ(100_000n * POS_SCALE_V22, 4);
    expect(q).toBe(10n * POS_SCALE_V22);
    expect(remainderTokenQ).toBe(0n);
    expect(formatLotPriceE6(11_960_000n, 4)).toBe(formatLotPriceE6(1_196n, 0));
  });
});

describe("order ticket: the OPEN summary's entry and worst-fill price are per TOKEN (L-1 browser check)", () => {
  it("OrderTicket formats estEntry and the slippage bound through formatLotPriceE6, never the raw per-lot formatter", () => {
    const s = readFileSync(path.join(__dirname, "../../../components/trade/OrderTicket.tsx"), "utf8");
    expect(s).toContain('<SummaryCell label="Entry" value={formatLotPriceE6(estEntry, lotExp)} />');
    expect(s).toContain("formatLotPriceE6(slippageBoundE6, lotExp)");
    expect(s).not.toMatch(/formatUsdPriceE6\(/);
  });
  it("CHILLHOUSE per-lot entry $11.8956 shows per token", () => {
    expect(formatLotPriceE6(11_895_580n, 4)).toBe("$0.00119");
    expect(formatLotPriceE6(11_895_580n, 4)).not.toMatch(/11\.89/);
    expect(formatLotPriceE6(11_895_580n, 0)).toBe("$11.895580");
  });
});

describe("indexer-candles-trades: rows are chain values (per lot); the app converts", () => {
  it("a JUP (lot_exp 2) row at the per-lot price $36.74 shows $0.3674; 3 lots show 300 tokens", () => {
    expect(formatPrice(36.7439, 2)).toBe(formatPrice(0.367439, 0));
    expect(formatSize("3000000", 2)).toBe(formatSize("300000000", 0));
  });
});

describe("trade-stats-panel: TradeStatsPanel withholds volume on v2.2", () => {
  const stats = (): TraderStatsResponse =>
    ({ totalTrades: 3, longTrades: 2, shortTrades: 1, uniqueMarkets: 1, totalVolume: "5000000000", totalFees: "0", feesRecorded: 0, tradesMissingPrice: 0, truncated: false, firstTradeAt: null, lastTradeAt: null } as unknown as TraderStatsResponse);
  it("gate: v2.2 without an attested lot-aware indexer -> unverified; flag off or attested -> unchanged", () => {
    const v = volumeDisplay(3, 0, "5000000000");
    expect(gateVolumeForV22(v, true, false)).toEqual({ kind: "unverified" });
    expect(gateVolumeForV22(v, false, false)).toEqual(v);
    expect(gateVolumeForV22(v, true, true)).toEqual(v);
    expect(gateVolumeForV22({ kind: "no-trades" }, true, false)).toEqual({ kind: "no-trades" });
  });
  it("renders '—' and the note with the flag on, the figure with it off", () => {
    __setDevnetV22ForTest(true);
    const a = render(<TradeStatsPanel stats={stats()} loading={false} error={null} />);
    expect(screen.getByText(VOLUME_UNVERIFIED_NOTE)).toBeTruthy();
    // #3399: Volume Traded is micro-USD shown as dollars (formatStatValue "currency"); withheld here.
    expect(document.body.textContent).not.toContain(formatStatValue(5_000_000_000n, "currency"));
    a.unmount();
    __setDevnetV22ForTest(false);
    render(<TradeStatsPanel stats={stats()} loading={false} error={null} />);
    expect(screen.queryByText(VOLUME_UNVERIFIED_NOTE)).toBeNull();
    expect(document.body.textContent).toContain(formatStatValue(5_000_000_000n, "currency"));
  });
});
