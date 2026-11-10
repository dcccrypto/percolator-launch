/**
 * Council r4 N5 (R3-7): with the portfolio scan failing, the dashboard StatsBar showed "..." beside
 * "No open positions". A failed scan is a failure: dashes, "Couldn't load", and a Retry; never the empty claim.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ portfolio: {} as Record<string, unknown> }));
vi.mock("@/hooks/usePortfolio", async (orig) => ({ ...(await orig<object>()), usePortfolio: () => state.portfolio }));

import { StatsBar } from "@/components/dashboard/StatsBar";

const base = { positions: [], totalPnl: 0n, totalDeposited: 0n, totalValue: 0n, totalUnrealizedPnl: 0n, unknownPnlCount: 0, atRiskCount: 0, isRefreshing: false };

describe("StatsBar under a failed portfolio scan", () => {
  beforeEach(() => { state.portfolio = { ...base, loading: false, error: "503", refresh: vi.fn() }; });

  it("says it could not load, offers Retry, never 'No open positions'", () => {
    const refresh = vi.fn();
    state.portfolio = { ...base, loading: false, error: "503", refresh };
    render(<StatsBar />);
    expect(screen.queryByText("No open positions")).toBeNull();
    expect(screen.queryByText("...")).toBeNull();
    expect(screen.getAllByText(/Couldn.t load your positions/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("still loading (no error yet): loading, not the empty claim", () => {
    state.portfolio = { ...base, loading: true, error: null, refresh: vi.fn() };
    render(<StatsBar />);
    expect(screen.queryByText("No open positions")).toBeNull();
  });

  it("CONTROL: loaded and empty is the real empty state", () => {
    state.portfolio = { ...base, loading: false, error: null, refresh: vi.fn() };
    render(<StatsBar />);
    expect(screen.getByText("No open positions")).toBeTruthy();
  });
});
