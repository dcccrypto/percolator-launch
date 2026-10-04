/**
 * /portfolio showed the liquidation distance twice with different numbers: the at-risk strip
 * read the 30s portfolio poll, the position card the live mark. The strip and the "at risk"
 * count now read the live mark too, so they show the card's distance and clear as soon as the
 * price recovers.
 */
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
import { computeLiqPrice } from "@/lib/trading";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";

const pk = new PublicKey("11111111111111111111111111111111");
const E6 = 1_000_000n;
// Default: a 10x long (1 unit at $100, 10 USDC, mm 5% / im 10%) polled at 97: half its margin
// cushion is gone (warning). Engine liquidation price 94.7368, so 2.3% away at the poll.
// liquidationPriceE6 comes from the real (engine) computeLiqPrice, as usePortfolio derives it.
const row = (slab: string, over: Record<string, unknown> = {}, opts: { mark?: bigint; capital?: bigint; size?: bigint } = {}) => {
  const mark = opts.mark ?? 97n * E6;
  const capital = opts.capital ?? 10n * E6;
  const size = opts.size ?? 1n * E6;
  const liq = computeLiqPrice(100n * E6, capital, size, 500n);
  return {
    slabAddress: slab, symbol: "SOL", idx: 0, collateralMint: pk,
    account: { kind: AccountKind.User, owner: pk, capital, positionSize: size, pnl: 0n, entryPrice: 100n * E6 },
    market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
    effectiveEntryPrice: 100n * E6, entryPriceSource: "cache", effectiveSize: size,
    unrealizedPnl: 0n, oraclePriceE6: mark, pnlPercent: 0, leverage: 10,
    liquidationPriceE6: liq, liquidationDistancePct: computeLiquidationDistancePct(size, mark, liq),
    nftWrapped: false, initialMarginBps: 1000n, maintenanceMarginBps: 500n,
    ...over,
  };
};

function renderWith(slab: string, over: Record<string, unknown> = {}, opts: { mark?: bigint; capital?: bigint; size?: bigint } = {}) {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
  vi.mocked(usePortfolio).mockReturnValue({
    positions: [row(slab, over, opts)], totalPnl: 0n, totalDeposited: 1_000_000n, loading: false, refresh: vi.fn(),
    // The poll's own count, deliberately stale: the page must not show it.
    atRiskCount: 1,
  } as any);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
  render(<PortfolioPositionsView />);
}
/** The at-risk strip (AtRiskBanner), or null when nothing is at risk. */
const strip = () => screen.queryByRole("region", { name: "Positions near liquidation" });
const stripShows = (pct: string) => expect(within(strip()!).getByText(pct)).toBeInTheDocument();

describe("/portfolio at-risk strip follows the live mark", () => {
  it("strip, card and count agree at the live price", () => {
    const slab = "SlabLiveRisk1111";
    renderWith(slab);
    stripShows("2.3%");
    act(() => applyOnChainPoll(slab, 95_800_000n)); // (95.8 - 94.7368) / 95.8 = 1.1%
    stripShows("1.1%");
    expect(screen.getByText("1.1% from liquidation")).toBeInTheDocument(); // the card
    expect(screen.getAllByText(/1 at risk/).length).toBeGreaterThan(0);
  });

  it("the count goes 0 -> 1 when a tick moves a safe position into range", () => {
    const slab = "SlabLiveRisk3333";
    // A fresh 5x long (20 USDC): engine liquidation at 84.21, safe at the poll.
    renderWith(slab, {}, { mark: 100n * E6, capital: 20n * E6 });
    expect(screen.queryByText(/at risk/)).not.toBeInTheDocument();
    act(() => applyOnChainPoll(slab, 91_000_000n)); // over half the way down: (91 - 84.21) / 91 = 7.5%
    expect(screen.getAllByText(/1 at risk/).length).toBeGreaterThan(0);
    stripShows("7.5%");
  });

  it("short: distance is measured up to the liquidation price", () => {
    const slab = "SlabLiveRisk4444";
    // 10x short at 100: engine liquidation at (100 + 10) / 1.05 = 104.76. Safe at the poll.
    renderWith(slab, {}, { mark: 100n * E6, size: -1n * E6 });
    expect(strip()).toBeNull();
    act(() => applyOnChainPoll(slab, 103_000_000n)); // (104.76 - 103) / 104.76 = 1.7%
    stripShows("1.7%");
  });

  it("clears when the price recovers, though the poll still says at risk", () => {
    const slab = "SlabLiveRisk2222";
    renderWith(slab);
    stripShows("2.3%");
    act(() => applyOnChainPoll(slab, 100_000_000n)); // back at entry: the whole cushion is there
    expect(strip()).toBeNull();
    expect(screen.queryByText(/at risk/)).not.toBeInTheDocument();
  });
});
