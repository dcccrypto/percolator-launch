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
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PortfolioPage from "@/app/portfolio/page";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";

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
vi.mock("@/hooks/usePortfolio");
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
            symbol: null,
            idx: 0,
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

      // Should display SOL/USD
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

      expect(screen.getByText(/No positions yet/i)).toBeInTheDocument();
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
});
