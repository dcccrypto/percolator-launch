/**
 * #3301: Close on a row acts on THAT row's portfolio account. Two rows of one wallet on one market
 * (the wrap / trade again / unwrap case) differ only by their account pubkey, so the click on the
 * second row must hand the second row's account to the close, for the modal's prewarm and for the
 * confirm. Covered for /portfolio (PortfolioCloseFlow) and for the trade page's other-markets list
 * and the at-risk strip / site-wide alert (CloseFlow, shared through RiskCloseFlow).
 */
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "@testing-library/react";
import { OtherMarketPositions } from "@/components/trade/OtherMarketPositions";
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
const closePosition = vi.fn(async () => ({ signature: "sig" }));
const prewarmClose = vi.fn();
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition, loading: false, error: null, prewarmClose }),
}));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSlabState: () => ({ params: { tradingFeeBps: 10n } }),
}));

const pk = new PublicKey("11111111111111111111111111111111");
const PK_A = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const PK_B = new PublicKey("SysvarRent111111111111111111111111111111111");
const base = {
  adlApplicable: false,
  idx: 0, collateralMint: pk,
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 100_000_000n, entryPriceSource: "cache",
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 0.5,
  liquidationPriceE6: 0n, liquidationDistancePct: 100, nftWrapped: false,
};
const mk = (portfolioPk: PublicKey, slabAddress: string, size: bigint) => ({
  ...base, slabAddress, symbol: "SOL", portfolioPk, effectiveSize: size,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000_000n, positionSize: size, pnl: 0n, entryPrice: 100_000_000n },
});

function setup(rows: ReturnType<typeof mk>[]) {
  closePosition.mockClear();
  prewarmClose.mockClear();
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as any);
  vi.mocked(usePortfolio).mockReturnValue({
    positions: rows, totalPnl: 0n, totalDeposited: 1_000_000_000n, loading: false, refresh: vi.fn(),
  } as any);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "SOL", decimals: 6 }]]) as any);
}

describe("#3301: Close binds the clicked row's account", () => {
  it("/portfolio: two owned accounts on one market; Close on the second row closes the SECOND account", async () => {
    // Same slab, two accounts: A long 5, B short 40 (B is the second row).
    setup([mk(PK_A, "SlabSame1111", 5_000_000n), mk(PK_B, "SlabSame1111", -40_000_000n)]);
    render(<PortfolioPositionsView />);
    const closes = screen.getAllByRole("button", { name: "Close" });
    expect(closes).toHaveLength(2);
    fireEvent.click(closes[1]);
    expect(prewarmClose).toHaveBeenCalledWith({ portfolioPk: PK_B });
    await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
    expect(closePosition).toHaveBeenCalledTimes(1);
    const [, opts] = closePosition.mock.calls[0] as unknown as [number, { portfolioPk: PublicKey }];
    expect(opts.portfolioPk.equals(PK_B)).toBe(true);
    expect(opts.portfolioPk.equals(PK_A)).toBe(false);
  });

  it("/portfolio: Close on the first row closes the FIRST account", async () => {
    setup([mk(PK_A, "SlabSame1111", 5_000_000n), mk(PK_B, "SlabSame1111", -40_000_000n)]);
    render(<PortfolioPositionsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
    const [, opts] = closePosition.mock.calls[0] as unknown as [number, { portfolioPk: PublicKey }];
    expect(opts.portfolioPk.equals(PK_A)).toBe(true);
  });

  it("trade page other-markets list (also the at-risk strip and the site alert's flow): each row closes its own account", async () => {
    const seen: string[] = [];
    for (const index of [0, 1]) {
      setup([mk(PK_A, "SlabOther1111", 5_000_000n), mk(PK_B, "SlabOther1111", -40_000_000n)]);
      const { unmount } = render(<OtherMarketPositions currentSlab="SlabCurrent" />);
      const closes = screen.getAllByRole("button", { name: "Close" });
      expect(closes).toHaveLength(2);
      fireEvent.click(closes[index]);
      const prewarmed = (prewarmClose.mock.calls[0][0] as { portfolioPk: PublicKey }).portfolioPk;
      await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
      const [, opts] = closePosition.mock.calls[0] as unknown as [number, { portfolioPk: PublicKey }];
      // The account prewarmed and the account closed are the one the clicked row was drawn from.
      expect(opts.portfolioPk.equals(prewarmed)).toBe(true);
      seen.push(opts.portfolioPk.toBase58());
      unmount();
    }
    expect(seen.sort()).toEqual([PK_A.toBase58(), PK_B.toBase58()].sort());
  });
});
