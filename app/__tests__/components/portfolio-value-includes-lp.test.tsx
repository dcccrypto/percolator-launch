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

describe("combinePortfolioValue: LP read errors", () => {
  it("an LP error with no positions is unread (left out and said so); with positions it keeps the last good value", () => {
    const base = { totalRedeemable: 0, loading: false };
    expect(combinePortfolioValue(10, { ...base, error: "rpc", positionCount: 0 }).lpUsd).toBeNull();
    expect(combinePortfolioValue(10, { totalRedeemable: 7, loading: false, error: "rpc", positionCount: 1 }).lpUsd).toBe(7);
  });
});

describe("Overview header Portfolio Value includes LP", () => {
  it("LP still loading: the headline is '...', not a trading-only number that later jumps", () => {
    setPortfolio({ totalDeposited: 100_000_000n });
    setLp({ loading: true });
    render(<DashboardHeader />);
    expect(screen.queryByText("$100.00")).not.toBeInTheDocument();
    expect(screen.getAllByText("...").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("header-value-breakdown")).toBeNull();
  });
  it("LP read failed with no positions: trading only, labelled not included", () => {
    setPortfolio({ totalDeposited: 100_000_000n });
    setLp({ positions: [], totalRedeemable: 0, error: "rpc down" });
    render(<DashboardHeader />);
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByTestId("header-value-breakdown")).toHaveTextContent("LP value unavailable (not included)");
  });
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
