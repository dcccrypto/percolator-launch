/**
 * #3637: /my-markets mounts the never-connected panel in the empty state (the market has no registry row, so the page has no
 * markets) AND beside a populated list. Sibling of my-markets-empty-state-recovery.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ myMarkets: [] as unknown[] }));
vi.mock("@/hooks/useCreatedMarkets", () => ({
  useCreatedMarkets: () => ({ myMarkets: state.myMarkets, loading: false, error: null, connected: true, refetch: vi.fn(), currentSlot: null }),
}));
vi.mock("@/hooks/useCreatorMarketDetails", () => ({ useCreatorMarketDetails: () => ({ details: {}, detailsLoading: false, refetch: vi.fn() }) }));
vi.mock("@/hooks/useMarketIdentities", () => ({ useMarketIdentities: () => ({}) }));
vi.mock("@/hooks/useLiveSlabPrices", () => ({ useLiveSlabPrices: () => new Map() }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/CreatorAttentionStrip", () => ({ CreatorAttentionStrip: () => null }));
vi.mock("@/components/my-markets/CreatorFeesPanel", () => ({ CreatorFeesPanel: () => null }));
vi.mock("@/components/my-markets/CreatorMarketRow", () => ({ CreatorMarketRow: () => null }));
vi.mock("@/components/my-markets/NeverConnectedPanel", () => ({ NeverConnectedPanel: () => <div data-testid="never-connected-mount" /> }));

import MyMarketsPage from "@/app/my-markets/page";

beforeEach(() => {
  state.myMarkets = [];
});

describe("/my-markets mounts the never-connected panel", () => {
  it("empty state (no registry-listed market)", () => {
    render(<MyMarketsPage />);
    expect(screen.getByTestId("never-connected-mount")).toBeDefined();
  });
  it("with listed markets", () => {
    state.myMarkets = [{ slabAddress: { toBase58: () => "SLAB1" }, config: {}, configV17: null }];
    render(<MyMarketsPage />);
    expect(screen.getByTestId("never-connected-mount")).toBeDefined();
  });
});
