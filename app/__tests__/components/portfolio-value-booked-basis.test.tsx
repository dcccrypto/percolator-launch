/**
 * r8 Council finding: on v2.2 the displayed Entry is the FILL price (booked +/- the spread part of the fee) and the displayed PnL is valued from it,
 * but the engine's equity is capital + q x (mark - booked): the spread already left capital as a fee. Every VALUE total (Positions tab hero,
 * Overview tile) must add the booked-basis PnL; the PnL line keeps the fill-based figure.
 *
 * Numbers: long 0.5 @ booked 100, paid 100.40 (fill), mark 100.20, capital 10. Fill PnL = -0.10, booked PnL = +0.10, value = 10.10 (not 9.90).
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
import { recordRealized } from "@/lib/realized-pnl";

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

import { saveEntryPrice } from "@/lib/entry-price";
import { portfolioPositionPnl, type PortfolioPnlSource } from "@/lib/position-pnl";
import { positionValuePnl } from "@/hooks/usePortfolio";

const mockPublicKey = new PublicKey("11111111111111111111111111111111");
const WALLET = mockPublicKey.toBase58();
const SLAB = "test-slab-fill";
const ADL_ONE = 1_000_000_000_000_000n;
const SIZE = 500_000n;
const BOOKED = 100_000_000n;
const PAID = 100_400_000n;
const MARK = 100_200_000n;
const CAPITAL = 10_000_000n;

const fillPosition = () => {
  const account = { adlABasis: ADL_ONE, kind: AccountKind.User, owner: mockPublicKey, capital: CAPITAL, positionSize: SIZE, pnl: 0n, reservedPnl: 0n, entryPrice: 0n };
  const base = {
    slabAddress: SLAB,
    symbol: "SOL",
    idx: 0,
    collateralMint: mockPublicKey,
    account,
    market: { slabAddress: mockPublicKey, config: { collateralMint: mockPublicKey }, engine: {} },
    effectiveEntryPrice: PAID,
    entryPriceSource: "cache",
    entryCacheWallet: WALLET,
    realizedLoss: 0n,
    oraclePriceE6: MARK,
    adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
    adlApplicable: true,
    initialMarginBps: 1000n,
    maintenanceMarginBps: 500n,
    leverage: 1,
    liquidationPriceE6: 0n,
    liquidationDistancePct: 100,
  };
  const p = portfolioPositionPnl(base as unknown as PortfolioPnlSource, MARK);
  return {
    ...base,
    unrealizedPnl: p.unrealizedPnl as bigint,
    riskUnrealizedPnl: p.riskUnrealizedPnl as bigint,
    riskEntryPrice: p.riskEntry,
    effectiveSize: p.effectiveSize as bigint,
    adlKnown: true,
    pnlKnown: p.pnlKnown,
    isEstimate: false,
    pnlPercent: 0,
  };
};

const mount = (pos: ReturnType<typeof fillPosition>, totalValue: bigint) => {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: mockPublicKey } as never);
  vi.mocked(usePortfolio).mockReturnValue({
    positions: [pos], totalPnl: pos.unrealizedPnl, totalDeposited: CAPITAL, totalValue, atRiskCount: 0,
    loading: false, isRefreshing: false, error: null, refresh: vi.fn(),
  } as never);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[WALLET, { symbol: "USDC", decimals: 6 }]]));
  return render(<PortfolioPositionsView />);
};

const heroValue = (): string => {
  const label = screen.getByText("Portfolio Value");
  return label.nextElementSibling?.textContent ?? "";
};

describe("Positions-tab Portfolio Value vs Overview value (fill != booked)", () => {
  it("the fixture really has fill != booked: display PnL -0.10, booked PnL +0.10", () => {
    localStorage.clear();
    saveEntryPrice(SLAB, 0, PAID, 3, WALLET, SIZE, { bookedPriceE6: BOOKED });
    const pos = fillPosition();
    expect(pos.unrealizedPnl).toBe(-100_000n);
    expect(pos.riskUnrealizedPnl).toBe(100_000n);
  });

  it("Positions-tab value = Overview value = capital + booked-basis PnL; the PnL line stays fill-based", () => {
    localStorage.clear();
    saveEntryPrice(SLAB, 0, PAID, 3, WALLET, SIZE, { bookedPriceE6: BOOKED });
    const pos = fillPosition();
    // The Overview tile (usePortfolio.totalValue) = deposits + sum(positionValuePnl).
    const overview = CAPITAL + positionValuePnl(pos);
    expect(overview).toBe(10_100_000n);
    mount(pos, overview);
    expect(heroValue()).toBe("$10.10");
    expect(heroValue()).not.toBe("$9.90");
    // the PnL line is the fill-based figure
    expect(screen.getAllByText(/-\$0\.10/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/\+\$0\.10/)).toBeNull();
  });
});
