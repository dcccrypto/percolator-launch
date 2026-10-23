/**
 * Audit finding #14 (portfolio half): after a FULL close with profit the
 * account is flat (positionSize 0, capital 0 — swept to wallet) with the
 * profit still parked in on-chain `pnl` until ConvertReleasedPnl claims it.
 * /portfolio must not hide that account: the Market Deposits section lists it
 * with the pending profit, and the Idle Deposits tile counts it.
 *
 * Mock scaffolding mirrors __tests__/components/Portfolio.test.tsx.
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

describe("swept profit visibility (audit #14)", () => {
  it("lists a flat zero-capital account whose pnl still holds profit", () => {
    mountWith([sweptProfitPosition()], 5_000_000n);

    // The account surfaces in Market Deposits with its pending profit...
    expect(screen.getByTestId("pending-profit")).toHaveTextContent("+5 profit");
    expect(screen.getByText("profit settling")).toBeInTheDocument();
    // ...both the hero Portfolio Value and the Idle Deposits tile count it
    // instead of $0.00 (Total Deposited stays a pure deposit figure)...
    expect(screen.getAllByText("$5.00").length).toBeGreaterThanOrEqual(2);
    // ...and the row links to the market whose Withdraw tab converts it.
    expect(screen.getByRole("link", { name: /Withdraw →/ })).toHaveAttribute(
      "href",
      "/trade/test-slab-swept",
    );
  });

  it("keeps a truly empty account (pnl 0) hidden", () => {
    const empty = sweptProfitPosition();
    empty.account.pnl = 0n;
    mountWith([empty]);

    expect(screen.queryByTestId("pending-profit")).toBeNull();
    expect(screen.getByText(/Browse markets to start trading/i)).toBeInTheDocument();
  });

  it("treats a u64::MAX sentinel pnl as no pending profit (v12 flat accounts)", () => {
    const sentinel = sweptProfitPosition();
    sentinel.account.pnl = 2n ** 64n - 1n;
    mountWith([sentinel]);

    expect(screen.queryByTestId("pending-profit")).toBeNull();
  });

  it("hides fully-reserved pnl (nothing the program would convert)", () => {
    const reserved = sweptProfitPosition();
    reserved.account.reservedPnl = 5_000_000n;
    mountWith([reserved]);

    expect(screen.queryByTestId("pending-profit")).toBeNull();
  });

  it("shows capital and pending profit side by side, both counted in the tile", () => {
    const mixed = sweptProfitPosition();
    mixed.account.capital = 3_000_000n;
    mixed.account.pnl = 2_000_000n;
    mountWith([mixed], 2_000_000n);

    const row = screen.getByRole("link", { name: /Withdraw →/ });
    expect(row).toHaveTextContent("3 USDC");
    expect(screen.getByTestId("pending-profit")).toHaveTextContent("+2 profit");
    expect(screen.getAllByText("$5.00").length).toBeGreaterThanOrEqual(2);
  });

  it("counts every swept account, not just the first", () => {
    const a = sweptProfitPosition();
    const b = sweptProfitPosition();
    b.slabAddress = "test-slab-swept-2";
    b.account.pnl = 2_000_000n;
    mountWith([a, b], 7_000_000n);

    const spans = screen.getAllByTestId("pending-profit");
    expect(spans).toHaveLength(2);
    expect(screen.getAllByText("$7.00").length).toBeGreaterThanOrEqual(2);
  });

  it("a plain idle deposit keeps its old badge and CTA", () => {
    const idle = sweptProfitPosition();
    idle.account.capital = 3_000_000n;
    idle.account.pnl = 0n;
    mountWith([idle]);

    expect(screen.getByText("idle collateral")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Trade →/ })).toBeInTheDocument();
    expect(screen.queryByTestId("pending-profit")).toBeNull();
  });
});
