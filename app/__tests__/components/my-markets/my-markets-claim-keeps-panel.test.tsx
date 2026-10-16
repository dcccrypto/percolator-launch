/**
 * S13: after a creator-fee claim the page called refetchMarkets as well as refetchDetails. A
 * re-scan withholds the verified market list (useCreatedMarkets, by design), so the page swapped
 * to the loading skeleton mid-claim and unmounted CreatorFeesPanel and the rows: claim-all's
 * progress, its result line, the "sent, not confirmed" note were lost, and a remounted panel could
 * re-offer claims still in flight. A claim only changes `details`, so only those are refetched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  /** Like the real hook: a re-scan withholds the list, so `loading` turns true until it lands. */
  loading: false,
  refetchMarkets: vi.fn(),
  refetchDetails: vi.fn(),
  panelClaimed: null as null | (() => void),
  rowClaimed: null as null | (() => void),
}));

const MARKET = {
  slabAddress: new PublicKey("HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop"),
  config: { unitScale: 0 },
  engine: { vault: 0n, totalOpenInterest: 0n, insuranceFund: { balance: 0n } },
};

vi.mock("@/hooks/useCreatedMarkets", () => ({
  useCreatedMarkets: () => ({
    myMarkets: [MARKET],
    loading: h.loading,
    error: null,
    connected: true,
    refetch: h.refetchMarkets,
    currentSlot: null,
  }),
}));
vi.mock("@/hooks/useCreatorMarketDetails", () => ({
  useCreatorMarketDetails: () => ({ details: {}, detailsLoading: false, refetch: h.refetchDetails }),
}));
vi.mock("@/hooks/useMarketIdentities", () => ({ useMarketIdentities: () => ({}) }));
vi.mock("@/hooks/useLiveSlabPrices", () => ({ useLiveSlabPrices: () => new Map() }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/CreatorAttentionStrip", () => ({ CreatorAttentionStrip: () => null }));
vi.mock("@/components/my-markets/CreatorFeesPanel", () => ({
  CreatorFeesPanel: (p: { onClaimed?: () => void }) => {
    h.panelClaimed = p.onClaimed ?? null;
    return <div data-testid="fees-panel" />;
  },
}));
vi.mock("@/components/my-markets/CreatorMarketRow", () => ({
  CreatorMarketRow: (p: { onClaimed?: () => void }) => {
    h.rowClaimed = p.onClaimed ?? null;
    return <div data-testid="market-row" />;
  },
}));

import MyMarketsPage from "@/app/my-markets/page";

beforeEach(() => {
  h.loading = false;
  h.refetchMarkets.mockReset();
  h.refetchMarkets.mockImplementation(() => { h.loading = true; });
  h.refetchDetails.mockClear();
  h.panelClaimed = null;
  h.rowClaimed = null;
});

describe("/my-markets: a creator-fee claim refreshes balances without re-scanning the market list", () => {
  it("a claim from the fees panel (claim-all) refetches details only; the panel stays mounted", () => {
    const { rerender } = render(<MyMarketsPage />);
    expect(h.panelClaimed).not.toBeNull();
    act(() => h.panelClaimed!());
    rerender(<MyMarketsPage />);
    expect(h.refetchDetails).toHaveBeenCalledTimes(1);
    expect(h.refetchMarkets).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fees-panel")).not.toBeNull();
  });

  it("a claim from a market row (incl. a sent-but-unconfirmed one) refetches details only", () => {
    const { rerender } = render(<MyMarketsPage />);
    expect(h.rowClaimed).not.toBeNull();
    act(() => h.rowClaimed!());
    rerender(<MyMarketsPage />);
    expect(h.refetchDetails).toHaveBeenCalledTimes(1);
    expect(h.refetchMarkets).not.toHaveBeenCalled();
    expect(screen.queryByTestId("market-row")).not.toBeNull();
  });
});
