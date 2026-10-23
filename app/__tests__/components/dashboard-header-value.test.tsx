/**
 * S23: the dashboard header's Portfolio Value was a bare token amount above zero ("1234.56", no "$")
 * and "$0.00" at zero, and it never read `loading`, so every cold load showed "$0.00" and 0 positions.
 * N8: it also left out profit still settling on flat accounts, which /portfolio's tile counts.
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const state = vi.hoisted(() => ({ portfolio: {} as Record<string, unknown> }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: new PublicKey("11111111111111111111111111111111") }),
}));
vi.mock("@/hooks/usePortfolio", async (orig) => ({ ...(await orig<object>()), usePortfolio: () => state.portfolio }));

import { DashboardHeader } from "@/components/dashboard/DashboardHeader";

const portfolio = (over: Record<string, unknown>) => {
  state.portfolio = {
    positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n,
    atRiskCount: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn(), ...over,
  };
};

describe("dashboard header Portfolio Value (S23)", () => {
  it("while the first scan loads: '...', not $0.00 and 0 positions", () => {
    portfolio({ loading: true });
    render(<DashboardHeader />);
    expect(screen.getAllByText("...")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("a loaded value is in dollars", () => {
    portfolio({ totalDeposited: 1_234_560_000n });
    render(<DashboardHeader />);
    expect(screen.getByText("$1,234.56")).toBeInTheDocument();
  });

  // N8: a profitable full close sweeps capital to the wallet and leaves the profit in `pnl` until
  // it is converted. /portfolio's Portfolio Value counts it (pendingProfit); this tile showed $0.00.
  const flat = (pnl: bigint, reservedPnl = 0n) =>
    ({ slabAddress: "Flat1111111111111111111111111111111111111111", account: { positionSize: 0n, capital: 0n, pnl, reservedPnl } });

  it("N8: profit still settling on a flat account counts, as on /portfolio", () => {
    portfolio({ positions: [flat(20_000_000n)] });
    render(<DashboardHeader />);
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });

  it("N8: with deposits elsewhere, the settling profit is added to them", () => {
    portfolio({ positions: [flat(20_000_000n)], totalDeposited: 100_000_000n });
    render(<DashboardHeader />);
    expect(screen.getByText("$120.00")).toBeInTheDocument();
  });

  it("N8 CONTROL: a u64::MAX sentinel pnl and fully reserved pnl add nothing", () => {
    portfolio({ positions: [flat(2n ** 64n - 1n), flat(5_000_000n, 5_000_000n)] });
    render(<DashboardHeader />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("CONTROL: a loaded empty account still reads $0.00 and 0", () => {
    portfolio({});
    render(<DashboardHeader />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
