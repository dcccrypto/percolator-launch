/**
 * /portfolio showed the liquidation distance twice with different numbers: the at-risk strip
 * read the 30s portfolio poll, the position card the live mark. The strip and the "at risk"
 * count now read the live mark too, so they show the card's distance and clear as soon as the
 * price recovers.
 */
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/useWalletCompat");
vi.mock("@/hooks/usePortfolio", async (io) => ({ ...(await io<typeof import("@/hooks/usePortfolio")>()), usePortfolio: vi.fn() }));
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/hooks/useLpPositions", () => ({ useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => <div /> }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: any) => <button>{children}</button> }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
import { act } from "react";
import { applyOnChainPoll } from "@/lib/priceStore/priceStore";

const pk = new PublicKey("11111111111111111111111111111111");
// Long, poll mark 100, liquidation at 80: 20% away at the poll's price.
const row = (slab: string, over: Record<string, unknown> = {}) => ({
  slabAddress: slab, symbol: "SOL", idx: 0, collateralMint: pk,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: 5_000_000n, pnl: 0n, entryPrice: 100_000_000n },
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 100_000_000n, entryPriceSource: "cache", effectiveSize: 5_000_000n,
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 5,
  liquidationPriceE6: 80_000_000n, liquidationDistancePct: 20, nftWrapped: false, initialMarginBps: 1000n,
  ...over,
});

function renderWith(slab: string, over: Record<string, unknown> = {}) {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
  vi.mocked(usePortfolio).mockReturnValue({
    positions: [row(slab, over)], totalPnl: 0n, totalDeposited: 1_000_000n, loading: false, refresh: vi.fn(),
    // The poll's own count, deliberately stale: the page must not show it.
    atRiskCount: 1,
  } as any);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
  render(<PortfolioPositionsView />);
}

describe("/portfolio at-risk strip follows the live mark", () => {
  it("strip, card and count agree at the live price", () => {
    const slab = "SlabLiveRisk1111";
    renderWith(slab);
    expect(screen.getByText("SOL (20.0%)")).toBeInTheDocument();
    act(() => applyOnChainPoll(slab, 85_000_000n)); // (85 - 80) / 85 = 5.88%
    expect(screen.getByText("SOL (5.9%)")).toBeInTheDocument();
    expect(screen.getByText(/Liquidation Risk — 5\.9% away/)).toBeInTheDocument();
    expect(screen.getAllByText(/1 at risk/).length).toBeGreaterThan(0);
  });

  it("the count goes 0 -> 1 when a tick moves a safe position into range", () => {
    const slab = "SlabLiveRisk3333";
    // Poll: liquidation at 50, 50% away, safe.
    renderWith(slab, { liquidationPriceE6: 50_000_000n, liquidationDistancePct: 50 });
    expect(screen.queryByText(/at risk/)).not.toBeInTheDocument();
    act(() => applyOnChainPoll(slab, 55_000_000n)); // (55 - 50) / 55 = 9.1%
    expect(screen.getAllByText(/1 at risk/).length).toBeGreaterThan(0);
    expect(screen.getByText("SOL (9.1%)")).toBeInTheDocument();
  });

  it("short: distance is measured up to the liquidation price", () => {
    const slab = "SlabLiveRisk4444";
    // Short at 100, liquidation at 120: (120 - 100) / 120 = 16.7% at the poll.
    renderWith(slab, {
      effectiveSize: -5_000_000n,
      account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: -5_000_000n, pnl: 0n, entryPrice: 100_000_000n },
      liquidationPriceE6: 120_000_000n, liquidationDistancePct: 16.67,
    });
    expect(screen.getByText("SOL (16.7%)")).toBeInTheDocument();
    act(() => applyOnChainPoll(slab, 115_000_000n)); // (120 - 115) / 120 = 4.17%
    expect(screen.getByText("SOL (4.2%)")).toBeInTheDocument();
  });

  it("clears when the price recovers, though the poll still says 20%", () => {
    const slab = "SlabLiveRisk2222";
    renderWith(slab);
    expect(screen.getByText("SOL (20.0%)")).toBeInTheDocument();
    act(() => applyOnChainPoll(slab, 120_000_000n)); // (120 - 80) / 120 = 33%: safe
    expect(screen.queryByText(/SOL \(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/at risk/)).not.toBeInTheDocument();
  });
});
