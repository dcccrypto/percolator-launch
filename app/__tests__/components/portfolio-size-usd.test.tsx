/**
 * The /portfolio position card adds the position's USD value at the live mark
 * ("≈ $97.00") under the base-unit size, and nothing when there is no mark.
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
const sizeUsd = () => screen.queryByTestId("position-size-usd");

describe("/portfolio card size in USD", () => {
  it("values the size at the polled mark until a tick arrives", () => {
    renderWith("SlabSizeUsd1111"); // 1 unit, polled at $97
    expect(sizeUsd()).toHaveTextContent("≈ $97.00");
  });

  it("follows the live mark; a short's value is its magnitude", () => {
    const slab = "SlabSizeUsd2222";
    renderWith(slab, {}, { size: -3n * E6 });
    act(() => applyOnChainPoll(slab, 101_500_000n));
    expect(sizeUsd()).toHaveTextContent("≈ $304.50");
  });

  it("no USD line without a mark (never $0.00)", () => {
    renderWith("SlabSizeUsd3333", {}, { mark: 0n });
    expect(sizeUsd()).toBeNull();
  });
});
