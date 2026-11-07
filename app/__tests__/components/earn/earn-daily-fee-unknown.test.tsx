/**
 * Council 2026-11-07 (LP seat, v22 preview 760f265f2): Earn showed "Daily fee revenue $0" as a real figure. On the v2.2
 * fresh set there is no indexer, so every market row carries stats_updated_at null with volume_24h / trade_count_24h
 * hard-coded to 0, while SOL traded many times that day. An untracked volume is unknown ("—"), like Insurance, not $0.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EarnHeader } from "@/components/earn/EarnHeader";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";

describe("volume is known only when stats were actually collected", () => {
  it("no row, or a row with no stats timestamp and no trades, is unknown; a stats row (even a quiet one) is known", async () => {
    const { buildMarketVaultInfo } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    const info = (row?: Record<string, unknown>) => buildMarketVaultInfo(SLAB, "T", "t", null, {}, row ? new Map([[SLAB, row]]) : new Map());
    expect(info().volumeKnown).toBe(false);
    expect(info({ stats_updated_at: null, volume_24h: 0, volume_24h_usd: 0, trade_count_24h: 0 }).volumeKnown).toBe(false);
    expect(info({ stats_updated_at: "2026-11-07T18:00:00Z", volume_24h: 0, volume_24h_usd: 0, trade_count_24h: 0 }).volumeKnown).toBe(true);
    expect(info({ stats_updated_at: null, volume_24h_usd: 120, last_price: 1, trade_count_24h: 3 }).volumeKnown).toBe(true);
  });

  it("the daily fee total is null when no market's volume is known, and sums only the known ones otherwise", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    const m = (volume24h: number, volumeKnown: boolean) => ({ insuranceFund: null, decimals: 6, vaultBalance: 0, totalOI: 0, maxOI: 0, volume24h, volumeKnown, tradingFeeBps: 30, symbol: "T" }) as never;
    expect(computeAggregates([m(0, false), m(0, false)]).dailyFeeRevenue).toBeNull();
    expect(computeAggregates([m(0, false), m(10_000, true), m(0, true)]).dailyFeeRevenue).toBe(30);
  });

  it("the header shows '—' for an unknown daily fee figure, and the CONTROL shows a known $0", () => {
    const base = { markets: [], tvl: 1000, totalInsurance: 5, totalOI: 0, maxOI: 0, unvaluedSymbols: [] };
    const { unmount } = render(<EarnHeader stats={{ ...base, dailyFeeRevenue: null } as never} loading={false} />);
    const cell = screen.getByText("Daily Fee Revenue").parentElement!;
    expect(cell.textContent).toContain("—");
    expect(cell.textContent).not.toContain("$0");
    unmount();
    render(<EarnHeader stats={{ ...base, dailyFeeRevenue: 0 } as never} loading={false} />);
    expect(screen.getByText("Daily Fee Revenue").parentElement!.textContent).toContain("$0");
  });
});
