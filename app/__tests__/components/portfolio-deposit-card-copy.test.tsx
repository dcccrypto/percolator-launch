/**
 * Copy QA item 10 (build 202fe5dcf): the portfolio "Market deposits" card read "USDCup to +5 profit" (no text space between the
 * symbol and the pending-profit chip: the gap was only a CSS margin). Mock scaffolding as portfolio-swept-profit.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock("next/dynamic", () => ({
  default: () => {
    const Component = () => <button>ConnectButton</button>;
    return Component;
  },
}));
vi.mock("@/hooks/useWalletCompat");
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return { ...actual, usePortfolio: vi.fn() };
});
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({
    positions: [],
    totalRedeemable: 0,
    loading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({
  LpPositionsPanel: () => <div data-testid="lp-positions-panel" />,
}));
vi.mock("@/hooks/useTraderStats", () => ({
  useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/components/ui/ScrollReveal", () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, href }: any) => (href ? <a href={href}>{children}</a> : <button>{children}</button>),
}));
vi.mock("@/lib/mock-mode", () => ({
  isMockMode: () => false,
  getMockPortfolioPositions: () => [],
}));

const mockPublicKey = new PublicKey("11111111111111111111111111111111");

/** Flat, fully-swept account: size 0, capital 0, profit still in `pnl`. */
const sweptProfitPosition = () => ({
  slabAddress: "test-slab-swept",
  symbol: "SOL",
  idx: 0,
  collateralMint: mockPublicKey,
  account: {
    adlABasis: 1_000_000_000_000_000n,
    kind: AccountKind.User,
    owner: mockPublicKey,
    capital: 0n,
    positionSize: 0n,
    pnl: 5_000_000n, // $5 released profit, unconverted
    reservedPnl: 0n,
    entryPrice: 0n,
  },
  market: { slabAddress: mockPublicKey, config: { collateralMint: mockPublicKey }, engine: {} },
  effectiveEntryPrice: 0n,
  entryPriceSource: "unknown",
  unrealizedPnl: 0n,
  realizedLoss: 0n,
  oraclePriceE6: 100_000_000n,
  effectiveSize: 0n,
  adlKnown: true,
  adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  adlApplicable: true,
  pnlKnown: true,
  isEstimate: false,
  pnlPercent: 0,
  leverage: 0,
  liquidationPriceE6: 0n,
  liquidationDistancePct: 100,
  initialMarginBps: 1000n,
});


const mountWith = (positions: ReturnType<typeof sweptProfitPosition>[], totalPnl = 0n) => {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: mockPublicKey } as never);
  vi.mocked(usePortfolio).mockReturnValue({
    positions,
    totalPnl,
    totalDeposited: 0n,
    atRiskCount: 0,
    loading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(),
  } as never);
  vi.mocked(useMultiTokenMeta).mockReturnValue(
    new Map([[mockPublicKey.toBase58(), { symbol: "USDC", decimals: 6 }]]),
  );
  render(<PortfolioPositionsView />);
};


describe("market deposit card text", () => {
  it("has a real space between the symbol and 'up to +X profit' (textContent, not margin)", () => {
    mountWith([sweptProfitPosition()], 5_000_000n);
    const row = screen.getByRole("link", { name: /Withdraw →/ });
    expect(row.textContent).toMatch(/USDC up to \+5 profit/);
    expect(row.textContent).not.toMatch(/USDCup/);
  });
  it("shows the collateral symbol, never a raw mint, when the mint resolves", () => {
    const p = sweptProfitPosition();
    p.account.capital = 3_000_000n;
    p.account.pnl = 0n;
    mountWith([p]);
    const row = screen.getByRole("link", { name: /Trade →/ });
    expect(row.textContent).toContain("3 USDC");
    expect(row.textContent).not.toContain(mockPublicKey.toBase58());
  });
  it("negative control: an idle deposit (no pending profit) renders no chip and no stray space before the CTA", () => {
    const p = sweptProfitPosition();
    p.account.capital = 3_000_000n;
    p.account.pnl = 0n;
    mountWith([p]);
    expect(screen.queryByTestId("pending-profit")).toBeNull();
    expect(screen.getByRole("link", { name: /Trade →/ }).textContent).not.toMatch(/USDC\s{2,}/);
  });
});
