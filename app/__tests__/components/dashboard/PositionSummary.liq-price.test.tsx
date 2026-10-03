/**
 * #2634: dashboard PositionSummary liquidation display.
 *
 * Live-PnL follow-up: PositionSummary labels Mark / PnL / ROE as current
 * position state, so it must consume the same shared live mark as the header
 * instead of waiting for usePortfolio's slower scan snapshot.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  positions: [] as any[],
  priceE6: null as bigint | null,
  listeners: new Set<() => void>(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/usePortfolio", () => ({
  usePortfolio: () => ({
    positions: state.positions,
    loading: false,
  }),
  getLiquidationSeverity: () => "safe",
  liveLiquidationDistancePct: () => 100,
  isOpenPosition: (p: { account?: { positionSize?: bigint } }) =>
    (p.account?.positionSize ?? 0n) !== 0n,
}));

vi.mock("@/hooks/useMultiTokenMeta", () => ({
  useMultiTokenMeta: () => new Map(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true }),
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));

vi.mock("@/components/ui/ShimmerSkeleton", () => ({
  ShimmerSkeleton: () => null,
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

import { PositionSummary } from "@/components/dashboard/PositionSummary";
import { computeLivePositionPnl } from "@/lib/trading";
import { computePositionLeverage, describePositionLeverage } from "@/lib/position-leverage";

const ENTRY_E6 = 100_000_000n;
const STALE_MARK_E6 = 120_000_000n;
const LIVE_MARK_E6 = 100_000_000n;
const SIZE = -1_000_000n;
const CAPITAL = 50_000_000n;
const INITIAL_MARGIN_BPS = 1_000n;

const pos = (over: Record<string, unknown>) => ({
  slabAddress: "Slab111111111111111111111111111111111111111",
  symbol: "SOL-PERP",
  collateralMint: { toBase58: () => "Mint" },

  effectiveSize: 1_000_000n,
  leverage: 1,

  liquidationDistancePct: 100,
  liquidationPriceE6: 0n,

  oraclePriceE6: 100_000_000n,
  unrealizedPnl: 0n,
  pnlPercent: 0,

  initialMarginBps: INITIAL_MARGIN_BPS,
  maintenanceMarginBps: 500n,

  // GH#2660: v17 has no native entry field. Use a resolved source rather
  // than allowing the mark placeholder to masquerade as Entry.
  effectiveEntryPrice: 100_000_000n,
  entryPriceSource: "cache",

  account: {
    positionSize: 1_000_000n,
    capital: 200_000_000n,
    entryPrice: 0n,
  },

  ...over,
});

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

  return pos({
    symbol: "SOLCAT-PERP",
    effectiveSize: SIZE,
    effectiveEntryPrice: ENTRY_E6,
    entryPriceSource: "cache",
    oraclePriceE6: STALE_MARK_E6,
    unrealizedPnl: stale.pnl,
    pnlPercent: stale.pnlPercent,
    initialMarginBps: INITIAL_MARGIN_BPS,
    maintenanceMarginBps: 500n,
    account: {
      positionSize: SIZE,
      capital: CAPITAL,
      entryPrice: 0n,
    },
  });
}

function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function publishLivePrice(priceE6: bigint) {
  state.priceE6 = priceE6;
  for (const listener of Array.from(state.listeners)) {
    listener();
  }
}

beforeEach(() => {
  state.positions = [];
  state.priceE6 = null;
  state.listeners.clear();
});

describe("PositionSummary Liq cell", () => {
  it("shows margin health, not a bare dash, when collateral covers the position", () => {
    state.positions = [pos({})];

    render(<PositionSummary />);

    expect(screen.getByText("200% mgn")).toBeInTheDocument();
  });

  it("shows the price when a liquidation price exists", () => {
    state.positions = [
      pos({
        liquidationPriceE6: 80_000_000n,
        account: {
          positionSize: 1_000_000n,
          capital: 50_000_000n,
          entryPrice: 0n,
        },
      }),
    ];

    render(<PositionSummary />);

    expect(screen.queryByText(/mgn/)).toBeNull();
    expect(screen.getByText(/80/)).toBeInTheDocument();
  });

  it("does not present an unresolved entry as covered", () => {
    state.positions = [pos({ entryPriceSource: "unknown" })];

    render(<PositionSummary />);

    expect(screen.queryByText(/mgn/)).toBeNull();
  });
});

describe("PositionSummary live PnL freshness", () => {
  it("CONTROL: keeps the portfolio snapshot result while the live mark has not moved", () => {
    const position = livePosition();
    state.positions = [position];
    state.priceE6 = STALE_MARK_E6;

    render(<PositionSummary />);

    expect(
      screen.getByText(pct(position.pnlPercent)),
    ).toBeInTheDocument();
  });

  it("recomputes Mark / PnL / ROE when the shared live mark changes", async () => {
    const position = livePosition();
    state.positions = [position];
    state.priceE6 = STALE_MARK_E6;

    const live = computeLivePositionPnl(
      SIZE,
      ENTRY_E6,
      LIVE_MARK_E6,
      INITIAL_MARGIN_BPS,
      CAPITAL,
      0n,
      0,
    );

    render(<PositionSummary />);

    act(() => {
      publishLivePrice(LIVE_MARK_E6);
    });

    await waitFor(() => {
      expect(
        screen.getByText(pct(live.pnlPercent)),
      ).toBeInTheDocument();
    });
  });
});

describe("PositionSummary — one card per portfolio, each on its own numbers", () => {
  // Two portfolios on the SAME market (usePortfolio returns one row per
  // portfolio account). A slab-keyed metric lookup collapsed them, so both
  // cards rendered whichever portfolio was inserted last.
  const SLAB = "Slab111111111111111111111111111111111111111";
  const MARK = 120_000_000n;

  function leg(entryE6: bigint, idx: number) {
    return pos({
      slabAddress: SLAB,
      idx,
      symbol: "SOL-PERP",
      effectiveSize: 1_000_000n,
      effectiveEntryPrice: entryE6,
      entryPriceSource: "cache",
      oraclePriceE6: MARK,
      account: { positionSize: 1_000_000n, capital: CAPITAL, entryPrice: 0n },
    });
  }

  it("renders each portfolio's own live ROE when two portfolios share a slab", () => {
    const a = leg(100_000_000n, 0);
    const b = leg(80_000_000n, 1);
    state.positions = [a, b];
    state.priceE6 = MARK;

    const roeA = computeLivePositionPnl(1_000_000n, 100_000_000n, MARK, INITIAL_MARGIN_BPS, CAPITAL, 0n, 0).pnlPercent;
    const roeB = computeLivePositionPnl(1_000_000n, 80_000_000n, MARK, INITIAL_MARGIN_BPS, CAPITAL, 0n, 0).pnlPercent;
    expect(pct(roeA)).not.toBe(pct(roeB));

    render(<PositionSummary />);

    expect(screen.getAllByText("(2)").length).toBeGreaterThan(0);
    expect(screen.getByText(pct(roeA))).toBeInTheDocument();
    expect(screen.getByText(pct(roeB))).toBeInTheDocument();
  });
});

describe("PositionSummary — leverage follows the same live mark as PnL", () => {
  it("prices the Lev badge at the shared live mark, not the scan snapshot", () => {
    const SIZE_Q = 1_000_000n; // 1 unit: $100 → 2×, $150 → 3× on $50 equity
    const STALE = 100_000_000n;
    const LIVE = 150_000_000n;
    state.positions = [
      pos({
        effectiveSize: SIZE_Q,
        oraclePriceE6: STALE,
        account: { positionSize: SIZE_Q, capital: CAPITAL, pnl: 0n, entryPrice: 0n },
      }),
    ];
    state.priceE6 = LIVE;

    const at = (markE6: bigint) =>
      describePositionLeverage(
        computePositionLeverage({ sizeQ: SIZE_Q, markPriceE6: markE6, capital: CAPITAL, pnl: 0n, collateralDecimals: 6 }),
      ).text;
    expect(at(LIVE)).not.toBe(at(STALE));
    expect(at(LIVE)).not.toBe("—");

    render(<PositionSummary />);

    expect(screen.getByText(`Lev ${at(LIVE)}`)).toBeInTheDocument();
    expect(screen.queryByText(`Lev ${at(STALE)}`)).toBeNull();
  });
});
