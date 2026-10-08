/**
 * #24: /portfolio's Close modal left out the trading fee, so its Est. Account Balance After was
 * higher than the same close from the market's own dock. It now passes the market's tradingFeeBps.
 */
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: () => {} }),
}));
const fresh = vi.hoisted(() => ({ oracle: "fresh" as string, engineStale: false }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: fresh.engineStale }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: fresh.oracle, mode: "keeper", ready: true }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSlabState: () => ({ params: { tradingFeeBps: 10n } }),
}));

const pk = new PublicKey("11111111111111111111111111111111");
// 5 SOL long at 100 (notional 500 USDC), capital 1,000 USDC.
// adlApplicable:false = a market with no ADL layer, so the effective size is the raw basis and the
// preview is available (#3089/#3090: an unknown ADL state on an ADL market hides the preview instead).
const row = {
  adlApplicable: false,
  slabAddress: "SlabPlain1111", symbol: "SOL", idx: 0, collateralMint: pk,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000_000n, positionSize: 5_000_000n, pnl: 0n, entryPrice: 100_000_000n },
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 100_000_000n, entryPriceSource: "cache", effectiveSize: 5_000_000n,
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 0.5,
  liquidationPriceE6: 0n, liquidationDistancePct: 100, nftWrapped: false,
};

function openClose(r: typeof row) {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
  vi.mocked(usePortfolio).mockReturnValue({
    positions: [r], totalPnl: 0n, totalDeposited: 1_000_000_000n, loading: false, refresh: vi.fn(),
  } as any);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
  render(<PortfolioPositionsView />);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  return screen.getByTestId("close-modal");
}

describe("#24: /portfolio close preview", () => {
  it("an unknown ADL state keeps the preview unavailable (no fee/balance row on a guessed size)", () => {
    const modal = openClose({ ...row, adlApplicable: true });
    expect(within(modal).getByTestId("close-preview-unavailable")).toBeInTheDocument();
    expect(within(modal).queryByText("Trading Fee:")).toBeNull();
  });

  it("subtracts the market's trading fee", () => {
    const modal = openClose(row);
    // 0.1% of 500 = 0.5
    expect(within(modal).getByText("Trading Fee:").parentElement!.textContent).toMatch(/0\.5\b/);
    // Capital 1000 + PnL 0 - fee 0.5 (1000 before the fix).
    expect(within(modal).getByText("Est. Account Balance After:").parentElement!.textContent).toMatch(/999\.5\b/);
  });

  it.each(["unavailable", "stale"])("a %s oracle blocks the /portfolio close like the dock does, labelled as the oracle", (level) => {
    fresh.oracle = level;
    try {
      const modal = openClose(row);
      expect(within(modal).getByText(/Oracle Stale/)).toBeInTheDocument();
      expect(within(modal).queryByTestId("close-catching-up")).toBeNull();
      const confirm = within(modal).getByTestId("close-confirm");
      expect(confirm).toBeDisabled();
    } finally {
      fresh.oracle = "fresh";
    }
  });

  it("engine catch-up is labelled as catching up, not as a stale oracle, and still blocks", () => {
    fresh.engineStale = true;
    try {
      const modal = openClose(row);
      expect(within(modal).getByTestId("close-catching-up")).toHaveTextContent("Prices are catching up");
      expect(within(modal).queryByText(/Oracle Stale/)).toBeNull();
      const confirm = within(modal).getByTestId("close-confirm");
      expect(confirm).toBeDisabled();
    } finally {
      fresh.engineStale = false;
    }
  });
});
