/**
 * A failed first position scan rendered as an empty account ($0.00, "No open positions") on
 * /portfolio and the dashboard. With usePortfolio().error set, those surfaces say the load
 * failed and offer Retry; without it, the real empty state is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const state = vi.hoisted(() => ({ portfolio: {} as any, lpError: null as string | null, lpTotal: 0 as number | null }));

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
  useLpPositions: () => ({ positions: [], totalRedeemable: state.lpTotal, loading: false, isRefreshing: false, error: state.lpError, refresh: vi.fn() }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/trade/TradeStatsPanel", () => ({ TradeStatsPanel: () => <div /> }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: any) => <button>{children}</button> }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { PnlChart } from "@/components/dashboard/PnlChart";
import { PositionSummary } from "@/components/dashboard/PositionSummary";

function failed(refresh = vi.fn()) {
  state.portfolio = {
    positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n,
    atRiskCount: 0, loading: false, isRefreshing: false, error: "Market directory returned 500", refresh,
  };
  return refresh;
}

describe("failed first position scan", () => {
  beforeEach(() => failed());

  it("positions view shows the error with Retry, not an empty $0 account", () => {
    const refresh = failed();
    render(<PortfolioPositionsView />);
    expect(screen.getByText("Couldn't load your positions")).toBeInTheDocument();
    expect(screen.queryByText("No open positions")).not.toBeInTheDocument();
    // LP Value comes from the Earn hook, which loaded fine; every figure from the failed scan reads "—".
    for (const label of ["Portfolio Value", "Total Deposited", "Open Positions", "Idle Deposits"]) {
      expect(screen.getByText(label).nextElementSibling?.textContent).toBe("—");
    }
    expect(screen.queryByText("unrealized", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("positions view shows the loading state, not the error, while loading", () => {
    state.portfolio = { ...state.portfolio, loading: true };
    render(<PortfolioPositionsView />);
    expect(screen.queryByText("Couldn't load your positions")).not.toBeInTheDocument();
  });

  it("positions view without an error still shows the real empty state", () => {
    state.portfolio = { ...state.portfolio, error: undefined };
    render(<PortfolioPositionsView />);
    expect(screen.getByText("No open positions")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your positions")).not.toBeInTheDocument();
  });

  it("dashboard header shows no $0.00 / 0", () => {
    render(<DashboardHeader />);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("PnL card says the load failed, not 'No positions yet'", () => {
    render(<PnlChart />);
    expect(screen.getByText("Couldn't load your positions")).toBeInTheDocument();
    expect(screen.queryByText("No positions yet")).not.toBeInTheDocument();
  });

  it("position summary shows the error with Retry", () => {
    const refresh = failed();
    render(<PositionSummary />);
    expect(screen.getByText("Couldn't load your positions")).toBeInTheDocument();
    expect(screen.queryByText("No open positions")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

});

// S25: the LP Value tile read only loading, so a failed Earn read (only `error` is set) showed "$0.00"
// while the tiles beside it say "—" for their own failed read.
describe("LP Value tile after a failed Earn read", () => {
  beforeEach(() => {
    state.portfolio = {
      positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n,
      atRiskCount: 0, loading: false, isRefreshing: false, error: undefined, refresh: vi.fn(),
    };
  });
  afterEach(() => { state.lpError = null; state.lpTotal = 0; });

  it("reads '—', not $0.00", () => {
    state.lpError = "Failed to load LP positions";
    render(<PortfolioPositionsView />);
    expect(screen.getByText("LP Value").nextElementSibling?.textContent).toBe("—");
  });

  // v2.2: a held first-loss stake whose value can't be read makes the LP total unknown (null): a dash, not a partial sum.
  it("reads '—' when the LP total is unknown (a stake value could not be read)", () => {
    state.lpTotal = null;
    render(<PortfolioPositionsView />);
    expect(screen.getByText("LP Value").nextElementSibling?.textContent).toBe("—");
  });

  it("CONTROL: a successful empty read is $0.00", () => {
    render(<PortfolioPositionsView />);
    expect(screen.getByText("LP Value").nextElementSibling?.textContent).toBe("$0.00");
  });
});
