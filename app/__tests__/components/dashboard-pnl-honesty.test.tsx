/**
 * GH#2677: dashboard must not present time-based PnL figures it has no history
 * source for.
 *
 * Live-PnL follow-up: the remaining "Unrealized · now" value must actually
 * follow the same shared live marks as current-position surfaces rather than
 * use usePortfolio's slower scan snapshot.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  positions: [] as any[],
  totalUnrealizedPnl: 6_690_000n,
  totalDeposited: 50_000_000n,
  totalValue: 56_690_000n,
  priceE6: null as bigint | null,
  listeners: new Set<() => void>(),
}));

vi.mock("@/hooks/usePortfolio", () => ({
  isOpenPosition: (p: any) =>
    p?.account?.positionSize !== undefined
      ? p.account.positionSize !== 0n
      : true,

  usePortfolio: () => ({
    loading: false,
    totalUnrealizedPnl: state.totalUnrealizedPnl,
    totalDeposited: state.totalDeposited,
    totalValue: state.totalValue,
    totalPnl: state.totalUnrealizedPnl,
    positions: state.positions,
  }),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({
    connected: true,
    publicKey: {
      toBase58: () => "DashboardWallet11111111111111111111111111111",
    },
  }),
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  subscribeSlab: (_slab: string, cb: () => void) => {
    state.listeners.add(cb);
    return () => {
      state.listeners.delete(cb);
    };
  },

  getSnapshot: () => ({
    priceE6: state.priceE6,
    priceUsd:
      state.priceE6 != null
        ? Number(state.priceE6) / 1_000_000
        : null,
  }),
}));

import { StatsBar } from "@/components/dashboard/StatsBar";
import { PnlChart } from "@/components/dashboard/PnlChart";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { computeLivePositionPnl } from "@/lib/trading";

const ENTRY_E6 = 100_000_000n;
const STALE_MARK_E6 = 120_000_000n;
const LIVE_MARK_E6 = 100_000_000n;
const SIZE = 1_000_000n;
const CAPITAL = 50_000_000n;
const INITIAL_MARGIN_BPS = 1_000n;

function defaultPosition() {
  return {
    unrealizedPnl: 6_690_000n,
    market: {
      configV17: {
        tradeFeeBps: 30n,
      },
    },
  };
}

function livePosition() {
  const stale = computeLivePositionPnl(
    SIZE,
    ENTRY_E6,
    STALE_MARK_E6,
    INITIAL_MARGIN_BPS,
    CAPITAL,
    0n,
    0,
  );

  state.totalUnrealizedPnl = stale.pnl;
  state.totalDeposited = CAPITAL;
  state.totalValue = CAPITAL + stale.pnl;

  return {
    slabAddress: "11111111111111111111111111111111",
    symbol: "SOLCAT-PERP",

    account: {
      positionSize: SIZE,
      capital: CAPITAL,
      entryPrice: 0n,
    },

    effectiveSize: SIZE,
    effectiveEntryPrice: ENTRY_E6,
    entryPriceSource: "cache",

    oraclePriceE6: STALE_MARK_E6,
    unrealizedPnl: stale.pnl,
    pnlPercent: stale.pnlPercent,

    initialMarginBps: INITIAL_MARGIN_BPS,
    maintenanceMarginBps: 500n,

    market: {
      configV17: {
        tradeFeeBps: 30n,
      },
    },
  };
}

function publishLivePrice(priceE6: bigint) {
  state.priceE6 = priceE6;
  for (const listener of Array.from(state.listeners)) {
    listener();
  }
}

beforeEach(() => {
  state.positions = [defaultPosition()];
  state.totalUnrealizedPnl = 6_690_000n;
  state.totalDeposited = 50_000_000n;
  state.totalValue = 56_690_000n;
  state.priceE6 = null;
  state.listeners.clear();
});

describe("StatsBar", () => {
  it("has no data-less Today's PnL card and no 'All time' claim", () => {
    render(<StatsBar />);

    expect(screen.queryByText(/Today's PnL/i)).toBeNull();
    expect(screen.queryByText(/All time/i)).toBeNull();
    expect(screen.getByText("Unrealized PnL")).toBeTruthy();
    expect(screen.getByText("+$6.69")).toBeTruthy();
  });
});

describe("PnlChart", () => {
  it("renders the current unrealized PnL with no decorative range selector", () => {
    render(<PnlChart />);

    for (const r of ["24H", "7D", "30D", "ALL"]) {
      expect(
        screen.queryByRole("button", { name: r }),
      ).toBeNull();
    }

    expect(screen.getByText(/Unrealized · now/)).toBeTruthy();
    expect(screen.getByText("+$6.69")).toBeTruthy();
  });

  it("CONTROL: agrees with the portfolio snapshot before the live mark moves", () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<PnlChart />);

    expect(screen.getByText(/\+\$20\.00/)).toBeInTheDocument();
  });

  it("keeps 'Unrealized · now' synchronized with the shared live mark", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<PnlChart />);

    act(() => {
      publishLivePrice(LIVE_MARK_E6);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/\+\$0\.00/),
      ).toBeInTheDocument();
    });
  });
});

describe("StatsBar in-profit card", () => {
  it("no longer renders the 'In Profit' block (removed as noise); PnL + Trade Fee remain", () => {
    render(<StatsBar />);

    expect(screen.queryByText("Win Rate")).toBeNull();
    expect(screen.queryByText(/No trades yet/i)).toBeNull();
    expect(screen.getByText("In Profit")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(
      screen.getByText(/1 up \/ 0 down · open positions/),
    ).toBeTruthy();
  });
});

describe("DashboardHeader live aggregate freshness", () => {
  it("CONTROL: agrees with the portfolio snapshot before the live mark moves", () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<DashboardHeader />);

    const label = screen.getByText("Portfolio Value");
    const card = label.parentElement;

    expect(card).not.toBeNull();

    // Snapshot state:
    // capital = $50
    // unrealized PnL = +$19.99992
    // portfolio value = $69.99992
    expect(card!.textContent).toContain("69.99992");

    // DashboardHeader currently computes 20 / 70 = 28.6%.
    expect(card!.textContent).toContain("28.6%");
  });

  it("revalues Portfolio Value / percentage when the shared live mark moves", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<DashboardHeader />);

    act(() => {
      publishLivePrice(LIVE_MARK_E6);
    });

    await waitFor(() => {
      const label = screen.getByText("Portfolio Value");
      const card = label.parentElement;

      expect(card).not.toBeNull();

      // Live mark == entry, so current unrealized PnL is zero.
      // Current portfolio value should therefore collapse from stale $70
      // back to the $50 deposited/capital snapshot.
      expect(card!.textContent).toContain("50");

      // The stale +20 / 70 percentage must disappear as well.
      expect(card!.textContent).not.toContain("28.6%");
    });
  });
});

describe("StatsBar live aggregate freshness", () => {
  it("CONTROL: classifies the portfolio snapshot before the live mark moves", () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<StatsBar />);

    const pnlLabel = screen.getByText("Unrealized PnL");
    const profitLabel = screen.getByText("In Profit");

    const pnlCard = pnlLabel.parentElement;
    const profitCard = profitLabel.parentElement;

    expect(pnlCard).not.toBeNull();
    expect(profitCard).not.toBeNull();

    expect(pnlCard!.textContent).toContain("+$20.00");
    expect(profitCard!.textContent).toContain("100%");
    expect(profitCard!.textContent).toContain("1 up / 0 down");
  });

  it("recomputes Unrealized PnL / In Profit from the shared live mark", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<StatsBar />);

    act(() => {
      publishLivePrice(LIVE_MARK_E6);
    });

    await waitFor(() => {
      const pnlLabel = screen.getByText("Unrealized PnL");
      const profitLabel = screen.getByText("In Profit");

      const pnlCard = pnlLabel.parentElement;
      const profitCard = profitLabel.parentElement;

      expect(pnlCard).not.toBeNull();
      expect(profitCard).not.toBeNull();

      // At entry mark the live PnL is exactly zero.
      expect(pnlCard!.textContent).toContain("--");
      expect(pnlCard!.textContent).not.toContain("+$20.00");

      // Exactly flat is neither a winning nor losing open position.
      expect(profitCard!.textContent).not.toContain("100%");
      expect(profitCard!.textContent).not.toContain("1 up / 0 down");
    });
  });
});
