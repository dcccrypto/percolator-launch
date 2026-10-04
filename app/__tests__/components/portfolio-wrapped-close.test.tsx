/**
 * /portfolio showed Close on every open row, including a position wrapped as a Position NFT.
 * The NFT holds that position, so useClosePosition never finds it and Close could never work.
 * Wrapped rows now show the trade page's Wrapped badge instead; other rows keep Close.
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

const pk = new PublicKey("11111111111111111111111111111111");
const row = (slab: string, nftWrapped: boolean) => ({
  slabAddress: slab, symbol: "SOL", idx: 0, collateralMint: pk,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: 5_000_000n, pnl: 0n, entryPrice: 100_000_000n },
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 100_000_000n, entryPriceSource: "cache", effectiveSize: 5_000_000n,
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 5,
  liquidationPriceE6: 40_000_000n, liquidationDistancePct: 60, nftWrapped,
});

describe("/portfolio wrapped rows", () => {
  it("wrapped row shows the Wrapped badge, not Close; plain row keeps Close", () => {
    vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
    vi.mocked(usePortfolio).mockReturnValue({
      positions: [row("SlabPlain1111", false), row("SlabWrapped111", true)],
      totalPnl: 0n, totalDeposited: 2_000_000n, loading: false, refresh: vi.fn(),
    } as any);
    vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
    render(<PortfolioPositionsView />);
    const links = screen.getAllByRole("link");
    const plain = links.find((a) => a.getAttribute("href") === "/trade/SlabPlain1111")!;
    const wrapped = links.find((a) => a.getAttribute("href") === "/trade/SlabWrapped111")!;
    expect(plain).toBeDefined();
    expect(wrapped).toBeDefined();
    expect(within(plain).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(plain).queryByText(/Wrapped/)).not.toBeInTheDocument();
    expect(within(wrapped).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(within(wrapped).getByText(/Wrapped/)).toHaveAttribute("title", expect.stringMatching(/Burn the NFT/));
  });
});
