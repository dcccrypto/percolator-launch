/**
 * R10 (Council r9 lp, low): with $25.03 in Earn + stake the headline Portfolio Value read $0.00 on both Overview
 * and Positions. It now includes the Earn and stake value, with a Trading / LP breakdown, and both pages agree.
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { combinePortfolioValue, portfolioValueBreakdownText } from "@/lib/portfolio-value";

const state = vi.hoisted(() => ({
  portfolio: {} as Record<string, unknown>,
  lp: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/usePortfolio", async (orig) => ({ ...(await orig<object>()), usePortfolio: () => state.portfolio }));
vi.mock("@/hooks/useLpPositions", () => ({ useLpPositions: () => state.lp }));

import { DashboardHeader } from "@/components/dashboard/DashboardHeader";

const setPortfolio = (over: Record<string, unknown> = {}) => {
  state.portfolio = {
    positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n,
    atRiskCount: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn(), ...over,
  };
};
const setLp = (over: Record<string, unknown> = {}) => {
  state.lp = { positions: [{}, {}], totalRedeemable: 25.03, loading: false, isRefreshing: false, error: null, refresh: vi.fn(), ...over };
};

describe("combinePortfolioValue", () => {
  const lp = { totalRedeemable: 25.03, loading: false, error: null, positionCount: 2 };
  it("adds LP to trading once", () => {
    const b = combinePortfolioValue(100, lp);
    expect(b.totalUsd).toBeCloseTo(125.03);
    expect(portfolioValueBreakdownText(b)).toBe("Trading $100.00 · LP $25.03");
  });
  it("an unreadable LP value is left out and said so, not read as $0", () => {
    const b = combinePortfolioValue(100, { ...lp, totalRedeemable: null });
    expect(b.totalUsd).toBe(100);
    expect(portfolioValueBreakdownText(b)).toContain("LP value unavailable");
  });
});

describe("Overview header Portfolio Value includes LP", () => {
  it("LP only: $25.03, not $0.00, with the breakdown", () => {
    setPortfolio();
    setLp();
    render(<DashboardHeader />);
    expect(screen.getByText("$25.03")).toBeInTheDocument();
    expect(screen.getByTestId("header-value-breakdown")).toHaveTextContent("Trading $0.00 · LP $25.03");
  });
  it("trading + LP are summed", () => {
    setPortfolio({ totalDeposited: 100_000_000n });
    setLp();
    render(<DashboardHeader />);
    expect(screen.getByText("$125.03")).toBeInTheDocument();
  });
});
