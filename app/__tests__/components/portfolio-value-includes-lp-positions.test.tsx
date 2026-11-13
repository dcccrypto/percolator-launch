/**
 * R10: the Positions tab Portfolio Value includes the Earn and stake value (it read $0.00 with $25.03 in LP),
 * with the same number as the Overview header (portfolio-value-includes-lp.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const state = vi.hoisted(() => ({ portfolio: {} as any, lpError: null as string | null, lpTotal: 25.03 as number | null }));

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  usePortfolio: () => state.portfolio,
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({ positions: [{}, {}], totalRedeemable: state.lpTotal, loading: false, isRefreshing: false, error: state.lpError, refresh: vi.fn() }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => <div /> }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: any) => <button>{children}</button> }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";

const loaded = () => {
  state.portfolio = {
    positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n,
    atRiskCount: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn(),
  };
};

describe("Positions tab Portfolio Value includes LP", () => {
  it("LP only: headline $25.03 with the Trading / LP breakdown", () => {
    loaded();
    state.lpTotal = 25.03;
    render(<PortfolioPositionsView />);
    expect(screen.getByText("Portfolio Value").nextElementSibling?.textContent).toBe("$25.03");
    expect(screen.getByTestId("value-breakdown")).toHaveTextContent("Trading $0.00 \u00b7 LP $25.03");
  });
  it("LP value unreadable: headline is trading only and says LP is not included", () => {
    loaded();
    state.lpTotal = null;
    render(<PortfolioPositionsView />);
    expect(screen.getByTestId("value-breakdown")).toHaveTextContent("LP value unavailable");
  });
});
