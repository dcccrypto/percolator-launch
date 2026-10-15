/**
 * S23: the dashboard header's Portfolio Value was a bare token amount above zero ("1234.56", no "$")
 * and "$0.00" at zero, and it never read `loading`, so every cold load showed "$0.00" and 0 positions.
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

  it("CONTROL: a loaded empty account still reads $0.00 and 0", () => {
    portfolio({});
    render(<DashboardHeader />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
