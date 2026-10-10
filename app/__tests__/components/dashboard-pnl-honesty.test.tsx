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
  // A real open leg (1 token long from $100 at a $106.69 mark = +$6.69), with the
  // ADL state known. The shared PnL helper derives the figure from these inputs;
  // a bare `{ unrealizedPnl }` stub no longer stands in for a position.
  return {
    slabAddress: "11111111111111111111111111111111",
    symbol: "SOLCAT-PERP",
    account: { adlABasis: 1_000_000_000_000_000n, positionSize: 1_000_000n, capital: CAPITAL, entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, pnl: 0n },
    effectiveSize: 1_000_000n,
    adlKnown: true,
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    adlApplicable: true,
    pnlKnown: true,
    isEstimate: false,
    effectiveEntryPrice: 100_000_000n,
    entryPriceSource: "cache",
    oraclePriceE6: 106_690_000n,
    unrealizedPnl: 6_690_000n,
    pnlPercent: 0,
    initialMarginBps: INITIAL_MARGIN_BPS,
    maintenanceMarginBps: 500n,
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

    account: { adlABasis: 1_000_000_000_000_000n,
      positionSize: SIZE,
      capital: CAPITAL,
      entryPrice: 0n,
    },

    effectiveSize: SIZE, adlKnown: true, adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n }, adlApplicable: true, pnlKnown: true, isEstimate: false,
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
      expect(screen.getByText("$0.00")).toBeInTheDocument();
    });
  });
});

describe("StatsBar has no in-profit card", () => {
  it("no longer renders the 'In Profit' block (removed as noise); PnL + Trade Fee remain", () => {
    render(<StatsBar />);

    expect(screen.queryByText("Win Rate")).toBeNull();
    expect(screen.queryByText(/No trades yet/i)).toBeNull();
    expect(screen.queryByText("In Profit")).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.queryByText(/up \/ \d+ down/)).toBeNull();
    expect(screen.getByText("Unrealized PnL")).toBeTruthy();
    expect(screen.getByText("Trade Fee")).toBeTruthy();
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
    // unrealized PnL = +$20 (one floor division, as the engine credits it; the old
    //   native-then-collateral path truncated it to +$19.99992)
    // portfolio value = $70
    expect(card!.textContent).toMatch(/Portfolio Value70(?![.d])/);

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
  it("CONTROL: shows the portfolio snapshot PnL before the live mark moves", () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<StatsBar />);

    const pnlLabel = screen.getByText("Unrealized PnL");
    const pnlCard = pnlLabel.parentElement;

    expect(pnlCard).not.toBeNull();
    expect(pnlCard!.textContent).toContain("+$20.00");
    expect(screen.queryByText("In Profit")).toBeNull();
  });

  it("recomputes Unrealized PnL from the shared live mark", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;

    render(<StatsBar />);

    act(() => {
      publishLivePrice(LIVE_MARK_E6);
    });

    await waitFor(() => {
      const pnlLabel = screen.getByText("Unrealized PnL");
      const pnlCard = pnlLabel.parentElement;

      expect(pnlCard).not.toBeNull();

      // At entry mark the live PnL is exactly zero: a known $0.00, not "--" (that is for
      // "no position has a known PnL", see the test below) and not "+$0.00".
      expect(pnlCard!.textContent).toContain("$0.00");
      expect(pnlCard!.textContent).not.toContain("+$");
      expect(pnlCard!.textContent).not.toContain("--");
      expect(screen.queryByText("In Profit")).toBeNull();
    });
  });
});

describe("dashboard aggregates say when a position's PnL is unknown (#3077 item 2)", () => {
  const unknownPosition = () => ({ ...defaultPosition(), entryPriceSource: "unknown", effectiveEntryPrice: 106_690_000n, unrealizedPnl: 0n });

  it("StatsBar: one known + one unknown keeps the number and names the exclusion", () => {
    state.positions = [defaultPosition(), unknownPosition()];
    render(<StatsBar />);
    expect(screen.getByText("+$6.69")).toBeTruthy();
    expect(screen.getByText(/Excludes 1 position /)).toBeTruthy();
  });

  it("StatsBar: every position unknown shows '--', not +$0.00", () => {
    state.positions = [unknownPosition()];
    render(<StatsBar />);
    expect(screen.getAllByText("--").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\+\$0\.00/)).toBeNull();
  });

  it("PnlChart: every position unknown shows '--' and the caveat", () => {
    state.positions = [unknownPosition()];
    render(<PnlChart />);
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.getByTestId("pnl-caveat").textContent).toMatch(/Excludes 1 position /);
  });

  it("CONTROL: all known -> no caveat", () => {
    state.positions = [defaultPosition()];
    render(<StatsBar />);
    expect(screen.queryByText(/Excludes/)).toBeNull();
  });
});

describe("a loss carries its minus sign", () => {
  // Entry $100, size 1: a $80 mark is exactly -$20.00. Before, these surfaces printed "$20.00"
  // in red (sign only by color): a loss read as a gain in a screenshot or to a colorblind user.
  const LOSS_MARK_E6 = 80_000_000n;

  it("PnlChart hero shows -$20.00", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;
    render(<PnlChart />);
    act(() => { publishLivePrice(LOSS_MARK_E6); });
    await waitFor(() => {
      expect(screen.getByText("-$20.00")).toBeInTheDocument();
    });
  });

  it("StatsBar with no positions keeps '--', not a green $0.00", () => {
    state.positions = [];
    state.totalUnrealizedPnl = 0n;
    render(<StatsBar />);
    const card = screen.getByText("Unrealized PnL").parentElement!;
    expect(card.textContent).toContain("--");
    expect(card.textContent).not.toContain("$0.00");
  });

  it("StatsBar Unrealized PnL shows -$20.00", async () => {
    state.positions = [livePosition()];
    state.priceE6 = STALE_MARK_E6;
    render(<StatsBar />);
    act(() => { publishLivePrice(LOSS_MARK_E6); });
    await waitFor(() => {
      const card = screen.getByText("Unrealized PnL").parentElement!;
      expect(card.textContent).toContain("-$20.00");
      expect(card.textContent).not.toContain("+$");
    });
  });
});
