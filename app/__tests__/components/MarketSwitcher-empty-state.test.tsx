/**
 * MarketSwitcher: the empty-state line in the dropdown said `No markets match ""`
 * while the market list was still loading, when it failed to load, and when there
 * were no markets at all. It now says which of those it is, and keeps "No markets
 * match" for a search that found nothing.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";

const mocks = vi.hoisted(() => ({
  stats: { statsMap: new Map(), loading: false, error: null as string | null },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => mocks.stats }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/lib/listed-markets", () => ({ isBrowsableMarketRow: () => true }));
vi.mock("@/hooks/usePortfolio", () => ({ usePortfolio: () => ({ positions: [], loading: false, error: null }), peekPortfolioSnapshot: () => null, portfolioCacheKey: () => "k" }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: false }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { MarketSwitcher } from "@/components/trade/MarketSwitcher";

const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

function openSwitcher() {
  render(<MarketSwitcher slabAddress={SOL} symbol="SOL" />);
  fireEvent.click(screen.getByTitle("Switch market"));
}

describe("MarketSwitcher empty state", () => {
  beforeEach(() => {
    mocks.stats = { statsMap: new Map(), loading: false, error: null };
  });
  afterEach(cleanup);

  it("says it is loading, not `No markets match \"\"`, while the list loads", () => {
    mocks.stats.loading = true;
    openSwitcher();
    expect(screen.getByText("Loading markets…")).toBeInTheDocument();
    expect(screen.queryByText(/No markets match/)).not.toBeInTheDocument();
  });

  it("says the list failed to load when the fetch errored", () => {
    mocks.stats.error = "Markets API returned 500";
    openSwitcher();
    expect(screen.getByText("Couldn't load markets")).toBeInTheDocument();
    expect(screen.queryByText(/No markets match/)).not.toBeInTheDocument();
  });

  it("says there are no markets when the list loaded empty", () => {
    openSwitcher();
    expect(screen.getByText("No markets yet")).toBeInTheDocument();
    expect(screen.queryByText(/No markets match/)).not.toBeInTheDocument();
  });

  it("CONTROL: a search with no hits still says no markets match it", () => {
    mocks.stats.statsMap = new Map([[SOL, { symbol: "SOL", last_price: 150, total_open_interest: 0 }]]);
    openSwitcher();
    fireEvent.change(screen.getByPlaceholderText("Search markets…"), { target: { value: "zzz" } });
    expect(screen.getByText('No markets match "zzz"')).toBeInTheDocument();
  });
});
