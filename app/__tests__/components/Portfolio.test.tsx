/**
 * Portfolio Component Tests
 * Tests: PORT-001, PORT-002, PORT-003, PORT-004, PORT-005
 * 
 * PORT-001: Display positions with null PnL (CRITICAL)
 * PORT-002: Manual refresh button
 * PORT-003: Auto-refresh timer
 * PORT-004: Token metadata loading
 * PORT-005: Empty portfolio state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Portfolio's positions view was extracted from app/portfolio/page.tsx into
// this component when /portfolio became a tabbed hub. These tests exercise the
// positions view directly (aliased to the old local name so the render calls
// below are unchanged).
import { PortfolioPositionsView as PortfolioPage } from "@/components/portfolio/PortfolioPositionsView";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";
import { computeLivePositionPnl } from "@/lib/trading";

// Mock Next.js
vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("next/dynamic", () => ({
  default: (fn: any) => {
    const Component = () => <button>ConnectButton</button>;
    return Component;
  },
}));

// Mock hooks
vi.mock("@/hooks/useWalletCompat");
// Only `usePortfolio` itself is mocked per-test via `vi.mocked(...).mockReturnValue(...)`
// below — `getLiquidationSeverity` (a pure function from the SAME module,
// used directly by both PortfolioPage and AtRiskBanner) must stay REAL, or
// every severity-dependent branch (liquidation banners, AtRiskBanner) would
// silently see `undefined` from the auto-mock and always fall through to
// the non-danger/non-warning path.
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return { ...actual, usePortfolio: vi.fn() };
});
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({
    positions: [],
    totalRedeemable: 0,
    loading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({
  LpPositionsPanel: () => <div data-testid="lp-positions-panel" />,
}));
vi.mock("@/hooks/useTraderStats", () => ({
  useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/components/trade/TradeStatsPanel", () => ({
  TradeStatsPanel: () => <div data-testid="trade-stats-panel" />,
}));
vi.mock("@/components/ui/ScrollReveal", () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children }: any) => <button>{children}</button>,
}));

vi.mock("@/lib/mock-mode", () => ({
  isMockMode: () => false,
  getMockPortfolioPositions: () => [],
}));

const mockPublicKey = new PublicKey("11111111111111111111111111111111");

describe("Portfolio Component Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("PORT-001: Display positions with null PnL (CRITICAL)", () => {
    it("should display 0.00 for null PnL without crashing", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [
          {
            slabAddress: "test-slab-123",
            symbol: "SOL",
            idx: 0,
            collateralMint: mockPublicKey,
            account: {
              kind: AccountKind.User,
              owner: mockPublicKey,
              capital: 1000000n,
              positionSize: 5000000n,
              pnl: null, // NULL PnL - critical test case
              entryPrice: 100000000n,
            },
            market: {
              slabAddress: mockPublicKey,
              config: {
                collateralMint: mockPublicKey,
              },
              engine: {},
            },
            // Enriched fields from usePortfolio
            // GH#2660: entryPriceSource and effectiveEntryPrice are what the
            // hook really emits and what the row reads. Omitting them left the
            // position in a state that cannot occur on v17, and a PnL is only
            // displayable when the entry it derives from actually resolved.
            effectiveEntryPrice: 100000000n,
            entryPriceSource: "cache",
            unrealizedPnl: 0n,
            oraclePriceE6: 100000000n,
            pnlPercent: 0,
            leverage: 5,
            liquidationPriceE6: 80000000n,
            liquidationDistancePct: 100,
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display +0 for null PnL (coalesced to 0n)
      expect(screen.getAllByText(/\+0/).length).toBeGreaterThanOrEqual(1);
    });

    it("should handle undefined PnL", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [
          {
            slabAddress: "test-slab-456",
            symbol: "USDC",
            idx: 0,
            collateralMint: mockPublicKey,
            account: {
              kind: AccountKind.User,
              owner: mockPublicKey,
              capital: 2000000n,
              positionSize: -3000000n,
              pnl: undefined, // Undefined PnL
              entryPrice: 95000000n,
            },
            market: {
              slabAddress: mockPublicKey,
              config: {
                collateralMint: mockPublicKey,
              },
              engine: {},
            },
            // Enriched fields from usePortfolio
            // GH#2660: entryPriceSource and effectiveEntryPrice are what the
            // hook really emits and what the row reads. Omitting them left the
            // position in a state that cannot occur on v17, and a PnL is only
            // displayable when the entry it derives from actually resolved.
            effectiveEntryPrice: 100000000n,
            entryPriceSource: "cache",
            unrealizedPnl: 0n,
            oraclePriceE6: 95000000n,
            pnlPercent: 0,
            leverage: 1.5,
            liquidationPriceE6: 110000000n,
            liquidationDistancePct: 100,
          },
        ],
        totalPnl: 0n,
        totalDeposited: 2000000n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "USDC", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should not crash and display +0
      expect(screen.getAllByText(/\+0/).length).toBeGreaterThanOrEqual(1);
    });

    it("should correctly display negative PnL", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [
          {
            slabAddress: "test-slab-789",
            symbol: "SOL",
            idx: 0,
            collateralMint: mockPublicKey,
            account: {
              kind: AccountKind.User,
              owner: mockPublicKey,
              capital: 1000000n,
              positionSize: 5000000n,
              pnl: -500000n, // -0.5 SOL loss
              entryPrice: 100000000n,
            },
            market: {
              slabAddress: mockPublicKey,
              config: {
                collateralMint: mockPublicKey,
              },
              engine: {},
            },
            // Enriched fields from usePortfolio
            unrealizedPnl: -500000n,
            oraclePriceE6: 100000000n,
            pnlPercent: -50,
            leverage: 5,
            liquidationPriceE6: 80000000n,
            liquidationDistancePct: 20,
            // #2660: the card reads the RESOLVED entry + its source, never the
            // (always-0n on v17/v18) account.entryPrice. A loss worth showing
            // needs a known entry; with source "unknown" the card shows "--".
            effectiveEntryPrice: 100000000n,
            entryPriceSource: "cache",
          },
        ],
        totalPnl: -500000n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display -0.5
      expect(screen.getAllByText(/-0\.5/).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PORT-002: Manual refresh button", () => {
    it("should call refresh function when refresh button is clicked", async () => {
      const mockRefresh = vi.fn();

      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: mockRefresh,
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      fireEvent.click(refreshButton);

      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should disable refresh button while loading", () => {
      const mockRefresh = vi.fn();

      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: true,
        refresh: mockRefresh,
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      expect(refreshButton).toBeDisabled();
    });
  });

  describe("PORT-003: Auto-refresh delegated to hook", () => {
    it("should not manage its own refresh interval (delegated to usePortfolio hook)", async () => {
      const mockRefresh = vi.fn();

      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        isRefreshing: false,
        refresh: mockRefresh,
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      // Page should not call refresh on its own timer — hook handles polling
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockRefresh).toHaveBeenCalledTimes(0);
    });
  });

  describe("PORT-004: Token metadata loading", () => {
    it("should show skeleton while token metadata is loading", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [
          {
            slabAddress: "test-slab",
            symbol: null,
            idx: 0,
            collateralMint: mockPublicKey,
            account: {
              kind: AccountKind.User,
              owner: mockPublicKey,
              capital: 1000000n,
              positionSize: 5000000n,
              pnl: 0n,
              entryPrice: 100000000n,
            },
            market: {
              slabAddress: mockPublicKey,
              config: {
                collateralMint: mockPublicKey,
              },
              engine: {},
            },
            unrealizedPnl: 0n,
            oraclePriceE6: 100000000n,
            pnlPercent: 0,
            leverage: 5,
            liquidationPriceE6: 80000000n,
            liquidationDistancePct: 100,
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      // Empty map = metadata still loading
      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      // Should show loading skeletons (ShimmerSkeleton uses shimmer-sweep animation,
      // rendered as a bg-[var(--border)] div with an inner shimmer overlay)
      const skeletons = screen.getAllByRole("generic").filter(
        (el) =>
          el.className.includes("animate-pulse") ||
          el.className.includes("bg-[var(--border)]")
      );
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it("should display position after metadata loads", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [
          {
            slabAddress: "test-slab-abc",
            symbol: "SOL",
            idx: 0,
            collateralMint: mockPublicKey,
            account: {
              kind: AccountKind.User,
              owner: mockPublicKey,
              capital: 1000000n,
              positionSize: 5000000n,
              pnl: 0n,
              entryPrice: 100000000n,
            },
            market: {
              slabAddress: mockPublicKey,
              config: {
                collateralMint: mockPublicKey,
              },
              engine: {},
            },
            unrealizedPnl: 0n,
            oraclePriceE6: 100000000n,
            pnlPercent: 0,
            leverage: 5,
            liquidationPriceE6: 80000000n,
            liquidationDistancePct: 100,
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      // Metadata loaded
      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display SOL/USD — labeled by the MARKET's symbol (resolved by
      // usePortfolio), not the shared sim-USDC collateral token's symbol.
      expect(screen.getByText(/SOL\/USD/i)).toBeInTheDocument();
    });
  });

  describe("PORT-005: Empty portfolio state", () => {
    it('should show "No positions yet" message when user has no positions', () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      expect(screen.getByText(/No open positions/i)).toBeInTheDocument();
      expect(screen.getByText(/Browse markets to start trading/i)).toBeInTheDocument();
    });

    it("should show Browse Markets button when empty", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const browseMarketsButton = screen.getByRole("button", { name: /Browse Markets/i });
      expect(browseMarketsButton).toBeInTheDocument();
      expect(browseMarketsButton.closest("a")).toHaveAttribute("href", "/markets");
    });

    it("should show wallet connection prompt when not connected", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: false,
        publicKey: null,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      expect(screen.getByText(/Connect your wallet to view positions/i)).toBeInTheDocument();
    });
  });

  describe("PORT-006: Tier 1 hero + Tier 2 regrouped stat tiles", () => {
    it("shows the Portfolio Value hero and the 4 regrouped Tier-2 tiles instead of the old 5-tile row", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        atRiskCount: 0,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(new Map());

      render(<PortfolioPage />);

      // Tier 1 hero
      expect(screen.getByText("Portfolio Value")).toBeInTheDocument();
      // Tier 2 — regrouped from the old 5-tile row; "Positions" is now
      // "Open Positions", and idle deposits get their own tile.
      expect(screen.getByText("Total Deposited")).toBeInTheDocument();
      expect(screen.getByText("LP Value")).toBeInTheDocument();
      expect(screen.getByText("Open Positions")).toBeInTheDocument();
      expect(screen.getByText("Idle Deposits")).toBeInTheDocument();
    });
  });

  describe("position leverage badge (current effective, notional / equity)", () => {
    const pos = (capital: bigint, pnl: bigint, positionSize = 40_000_000n) => ({
      slabAddress: "test-slab-lev",
      symbol: "SOL",
      idx: 0,
      collateralMint: mockPublicKey,
      account: { kind: AccountKind.User, owner: mockPublicKey, capital, positionSize, pnl, entryPrice: 100000000n },
      market: { slabAddress: mockPublicKey, config: { collateralMint: mockPublicKey }, engine: {} },
      effectiveEntryPrice: 100000000n,
      entryPriceSource: "cache",
      unrealizedPnl: 0n,
      oraclePriceE6: 100_000_000n, // $100 mark
      effectiveSize: positionSize,
      pnlPercent: 0,
      leverage: 999, // the stale hook figure must NOT be what is shown
      liquidationPriceE6: 80000000n,
      liquidationDistancePct: 100,
      initialMarginBps: 1000n,
    });
    const renderWith = (p: ReturnType<typeof pos>) => {
      vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: mockPublicKey });
      vi.mocked(usePortfolio).mockReturnValue({
        positions: [p], totalPnl: 0n, totalDeposited: 1n, atRiskCount: 0, loading: false, refresh: vi.fn(),
      } as never);
      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]]),
      );
      render(<PortfolioPage />);
    };

    it("shows Lev = |size| x mark / (capital + pnl): 40 x $100 on $1000 = 4x", () => {
      renderWith(pos(1_000_000_000n, 0n));
      expect(screen.getByTestId("position-leverage-badge").textContent).toBe("Lev 4×");
    });

    it("uses equity (capital + pnl): -$500 pnl doubles it to 8x", () => {
      renderWith(pos(1_000_000_000n, -500_000_000n));
      expect(screen.getByTestId("position-leverage-badge").textContent).toBe("Lev 8×");
    });

    it("shows no leverage badge (dash in the stat) when equity <= 0", () => {
      renderWith(pos(1_000_000_000n, -1_000_000_000n));
      expect(screen.queryByTestId("position-leverage-badge")).toBeNull();
    });
  });

  describe("PORT-007: AtRiskBanner", () => {
    const buildPosition = (overrides: Record<string, unknown> = {}) => ({
      slabAddress: "test-slab-risk",
      symbol: "SOL",
      idx: 0,
      collateralMint: mockPublicKey,
      account: {
        kind: AccountKind.User,
        owner: mockPublicKey,
        capital: 1000000n,
        positionSize: 5000000n,
        pnl: -900000n,
        entryPrice: 100000000n,
      },
      market: {
        slabAddress: mockPublicKey,
        config: { collateralMint: mockPublicKey },
        engine: {},
      },
      collateralMint2: mockPublicKey,
      effectiveEntryPrice: 100000000n,
      // #2671 allowlist: a position with NO source cannot occur (the hook
      // always emits one) and is now treated as an unresolved entry.
      entryPriceSource: "cache",
      unrealizedPnl: -900000n,
      oraclePriceE6: 92000000n,
      pnlPercent: -90,
      leverage: 5,
      effectiveSize: 5000000n,
      // (92 - 87.4) / 92 = 5%: the strip recomputes this from the mark (live, else oracle).
      liquidationPriceE6: 87400000n,
      // Within "danger" distance (<=10%, see getLiquidationSeverity).
      liquidationDistancePct: 5,
      initialMarginBps: 1000n,
      ...overrides,
    });

    it("renders a liquidation-risk strip listing the at-risk symbol when a position is within danger distance", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        positions: [buildPosition()],
        totalPnl: -900000n,
        totalDeposited: 1000000n,
        atRiskCount: 1,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // The strip (AtRiskBanner) lists the position with its distance and actions.
      const strip = screen.getByRole("region", { name: "Positions near liquidation" });
      expect(within(strip).getByText("Liquidation risk")).toBeInTheDocument();
      expect(within(strip).getByText("SOL")).toBeInTheDocument();
      expect(within(strip).getByText("5.0%")).toBeInTheDocument();
      expect(within(strip).getByRole("link", { name: "Go to market" })).toHaveAttribute("href", "/trade/test-slab-risk");
    });

    it("renders nothing (zero height) when no position is at risk", () => {
      vi.mocked(useWalletCompat).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      vi.mocked(usePortfolio).mockReturnValue({
        // liquidationPriceE6: 0n too — PositionCard recomputes ITS OWN
        // liquidationDistancePct live from (liquidationPriceE6, markE6) when
        // both are positive, which would otherwise override this "safe"
        // distance regardless of the field set here.
        positions: [buildPosition({ liquidationDistancePct: 100, liquidationPriceE6: 0n })],
        totalPnl: -900000n,
        totalDeposited: 1000000n,
        atRiskCount: 0,
        loading: false,
        refresh: vi.fn(),
      });

      vi.mocked(useMultiTokenMeta).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // `ignore` skips the always-mounted tooltip span. <Tooltip> keeps its
      // copy in the DOM permanently and hides it with inline
      // visibility/opacity (it animates on hover), so its text is invisible to
      // users but still visible to queryByText. RISK_LEVERAGE_TITLE ends with
      // "...lowers liquidation risk.", which matched this /i assertion the
      // moment the Risk Lev. label swapped its `title=` attribute for an
      // <InfoIcon>. Hidden tooltip copy is not a rendered banner, so it must
      // not satisfy these assertions.
      const ignoreTooltip = { ignore: '[role="tooltip"]' } as const;
      expect(
        screen.queryByText(/Liquidation risk/i, ignoreTooltip)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Approaching liquidation/i, ignoreTooltip)
      ).not.toBeInTheDocument();
    });
  });

  describe("PORT-008: computeLivePositionPnl (lib/trading.ts) — shared live-PnL math", () => {
    // Extracted from PositionCard/PositionChip's identical duplicated IIFEs
    // (PERF PLAN #3) — these pin the exact chain: computeMarkPnl (native) ->
    // computeMarkPnlCollateral (collateral) -> ROE ÷ initial margin.
    it("computes live PnL/ROE for a long position whose mark moved up", () => {
      const { pnl, pnlPercent } = computeLivePositionPnl(
        5_000_000n, // positionSize (long)
        100_000_000n, // entryPriceE6 ($100)
        110_000_000n, // markPriceE6 ($110, live tick above entry)
        1_000n, // initialMarginBps (10%)
        0n, // capitalFallback (unused — initial margin is > 0)
        -1n, // unrealizedPnlFallback (sentinel — must NOT be returned)
        -1, // pnlPercentFallback (sentinel — must NOT be returned)
      );
      expect(pnl).toBeGreaterThan(0n);
      expect(pnlPercent).toBeGreaterThan(0);
    });

    it("falls back to the provided fallbacks when the position is flat", () => {
      const { pnl, pnlPercent } = computeLivePositionPnl(
        0n, // flat position
        100_000_000n,
        110_000_000n,
        1_000n,
        0n,
        -777n,
        -77,
      );
      expect(pnl).toBe(-777n);
      expect(pnlPercent).toBe(-77);
    });

    it("falls back to unrealizedPnlFallback for `pnl` when the live mark isn't available yet (markPriceE6 <= 0)", () => {
      // NOTE: `pnlPercent` is preserved VERBATIM from the original
      // PositionCard/PositionChip IIFEs, which recompute ROE from the
      // position's OWN entry/size/marginBps independent of whether a live
      // mark was available — only `pnl` itself short-circuits to the
      // fallback. So with a nonzero entry/size, `pnlPercent` here is NOT
      // simply `pnlPercentFallback`; it's the fallback `pnl` divided by the
      // position's real (mark-independent) initial margin.
      const { pnl, pnlPercent } = computeLivePositionPnl(
        5_000_000n,
        100_000_000n,
        0n, // no live tick yet
        1_000n,
        0n,
        123n,
        4.5,
      );
      expect(pnl).toBe(123n);
      expect(Number.isFinite(pnlPercent)).toBe(true);
      expect(pnlPercent).not.toBe(4.5);
    });

    it("falls back to pnlPercentFallback when NEITHER a live mark NOR an entry price is available", () => {
      const { pnl, pnlPercent } = computeLivePositionPnl(
        5_000_000n,
        0n, // no entry price either -> initial margin is also 0
        0n,
        1_000n,
        0n, // capitalFallback = 0 -> falls all the way through to pnlPercentFallback
        123n,
        4.5,
      );
      expect(pnl).toBe(123n);
      expect(pnlPercent).toBe(4.5);
    });

    it("falls back to capitalFallback for ROE when initial margin is zero (e.g. no entry price)", () => {
      const { pnlPercent } = computeLivePositionPnl(
        5_000_000n,
        100_000_000n,
        110_000_000n,
        0n, // initialMarginBps = 0 -> computePositionInitialMargin returns 0
        2_000_000n, // capitalFallback > 0 -> used for ROE denominator
        0n,
        0,
      );
      expect(Number.isFinite(pnlPercent)).toBe(true);
    });
  });
});
