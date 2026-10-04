/**
 * #2967: a creator whose ONLY launch is stuck has no market in myMarkets (an
 * uninitialised slab is never discovered as theirs), so /my-markets renders its
 * empty state — which used to skip CreatorAttentionStrip and therefore the
 * recovery card entirely. The empty state must mount the card too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  myMarkets: [] as unknown[],
  connected: true,
  loading: false,
  error: null as string | null,
}));

vi.mock("@/hooks/useCreatedMarkets", () => ({
  useCreatedMarkets: () => ({
    myMarkets: state.myMarkets,
    loading: state.loading,
    error: state.error,
    connected: state.connected,
    refetch: vi.fn(),
    currentSlot: null,
  }),
}));
vi.mock("@/hooks/useCreatorMarketDetails", () => ({
  useCreatorMarketDetails: () => ({ details: {}, detailsLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useMarketIdentities", () => ({ useMarketIdentities: () => ({}) }));
vi.mock("@/hooks/useLiveSlabPrices", () => ({ useLiveSlabPrices: () => new Map() }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("gsap", () => ({ default: { fromTo: vi.fn() } }));
// The banner itself is covered by the recover-sol-banner-* suites; here we only
// need to know whether the page mounts it, and with which props.
const bannerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/components/create/RecoverSolBanner", () => ({
  RecoverSolBanner: (props: Record<string, unknown>) => {
    bannerProps.push(props);
    return <div data-testid="recover-sol-banner" />;
  },
}));
vi.mock("@/components/my-markets/CreatorAttentionStrip", () => ({
  CreatorAttentionStrip: () => <div data-testid="attention-strip" />,
}));

import MyMarketsPage from "@/app/my-markets/page";

beforeEach(() => {
  state.myMarkets = [];
  state.connected = true;
  state.loading = false;
  state.error = null;
  bannerProps.length = 0;
});

describe("/my-markets empty state and the stuck-launch card", () => {
  it("mounts the recovery card (callback-free) when the wallet has no listed markets", () => {
    render(<MyMarketsPage />);
    expect(screen.getByText(/haven.t created a market with this wallet yet/)).toBeDefined();
    expect(screen.getByTestId("recover-sol-banner")).toBeDefined();
    // Callback-free mount: the banner's own no-onResume/no-onReset branches
    // (links to /create, honest DISCARD/CLEAR labels) are what render here.
    expect(bannerProps.at(-1)).toEqual({});
  });
});
