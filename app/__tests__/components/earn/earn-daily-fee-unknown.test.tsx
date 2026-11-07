/**
 * Council 2026-11-07 (LP seat, v22 preview 760f265f2): Earn showed "Daily fee revenue $0" as a real figure. On the v2.2
 * fresh set there is no indexer: /api/markets serves on-chain discovery rows whose volume_24h / trade_count_24h are
 * hard-coded 0 placeholders, while SOL traded many times that day. An untracked volume is unknown ("—"), like
 * Insurance, not $0.
 *
 * Row shapes used here are the ones the server actually produces:
 * - discovery / static-fallback rows (no indexer): volume_24h 0, trade_count_24h 0, stats_collected false;
 * - Supabase markets_with_stats rows (playground): volume_24h / trade_count_24h from market_stats, no stats_collected
 *   key and no stats_updated_at key (not selected, lib/market-registry.ts); a registry-only market (no market_stats
 *   row, LEFT JOIN) has volume_24h / trade_count_24h null.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EarnHeader } from "@/components/earn/EarnHeader";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";

async function infoFor(row?: Record<string, unknown>) {
  const { buildMarketVaultInfo } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
  return buildMarketVaultInfo(SLAB, "T", "t", null, {}, row ? new Map([[SLAB, row]]) : new Map());
}

describe("volume is known only when an indexer actually reported it", () => {
  it("no row at all is unknown", async () => {
    expect((await infoFor()).volumeKnown).toBe(false);
  });
  it("a discovery / static row (stats_collected false, placeholder zeros) is unknown", async () => {
    expect((await infoFor({ stats_collected: false, stats_updated_at: null, volume_24h: 0, volume_24h_usd: 0, trade_count_24h: 0 })).volumeKnown).toBe(false);
  });
  it("a Supabase quiet day (market_stats row reporting 0 volume / 0 trades) is a KNOWN zero", async () => {
    expect((await infoFor({ volume_24h: "0", trade_count_24h: 0, last_price: 1 })).volumeKnown).toBe(true);
  });
  it("a Supabase registry-only market (no market_stats row: volume / trades null) is unknown", async () => {
    expect((await infoFor({ volume_24h: null, trade_count_24h: null, last_price: 1 })).volumeKnown).toBe(false);
  });
  it("trades / raw volume reported but no USD value (no usable price) is unknown, not a $0 understatement", async () => {
    const i = await infoFor({ volume_24h: "5000000", trade_count_24h: 3, last_price: null, volume_24h_usd: null });
    expect(i.volume24h).toBe(0);
    expect(i.volumeKnown).toBe(false);
  });
  it("real activity always counts as known, even on a row flagged stats_collected false", async () => {
    const i = await infoFor({ stats_collected: false, volume_24h_usd: 120, last_price: 1, trade_count_24h: 3 });
    expect(i.volumeKnown).toBe(true);
    expect(i.volume24h).toBe(120);
  });
});

describe("daily fee aggregation", () => {
  const m = (volume24h: number, volumeKnown: boolean | undefined, tradingFeeBps = 30) =>
    ({ insuranceFund: null, decimals: 6, vaultBalance: 0, totalOI: 0, maxOI: 0, volume24h, volumeKnown, tradingFeeBps, symbol: "T" }) as never;
  it("is null when no market's volume is known", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    expect(computeAggregates([m(0, false), m(0, false)]).dailyFeeRevenue).toBeNull();
    expect(computeAggregates([]).dailyFeeRevenue).toBeNull();
  });
  it("a known quiet set is $0, not unknown", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    expect(computeAggregates([m(0, true), m(0, true)]).dailyFeeRevenue).toBe(0);
  });
  it("sums volume × fee over the known markets only (partial coverage), with per-market fee bps", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    // 10_000 × 30bps = 30; 2_000 × 10bps = 2; the unknown one is excluded even if it carried a number.
    expect(computeAggregates([m(999_999, false), m(10_000, true), m(2_000, true, 10)]).dailyFeeRevenue).toBeCloseTo(32, 10);
  });
  it("mock / fixture markets with no volumeKnown field keep their figure (undefined = known)", async () => {
    const { computeAggregates } = await vi.importActual<typeof import("@/hooks/useEarnStats")>("@/hooks/useEarnStats");
    expect(computeAggregates([m(10_000, undefined)]).dailyFeeRevenue).toBe(30);
  });
});

describe("header", () => {
  it("shows '—' for an unknown daily fee figure, and the CONTROL shows a known $0", () => {
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
