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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PortfolioPage from "@/app/portfolio/page";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolator/core";

// Mock Next.js
vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

vi.mock("next/dynamic", () => ({
  default: (fn: any) => {
    const Component = () => <button>WalletMultiButton</button>;
    return Component;
  },
}));

// Mock hooks
vi.mock("@solana/wallet-adapter-react");
vi.mock("@/hooks/usePortfolio");
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/components/ui/ScrollReveal", () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children }: any) => <button>{children}</button>,
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
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
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
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display +0 for null PnL (coalesced to 0n)
      expect(screen.getByText(/\+0/)).toBeInTheDocument();
    });

    it("should handle undefined PnL", () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
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
          },
        ],
        totalPnl: 0n,
        totalDeposited: 2000000n,
        loading: false,
        refresh: vi.fn(),
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "USDC", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should not crash and display +0
      expect(screen.getByText(/\+0/)).toBeInTheDocument();
    });

    it("should correctly display negative PnL", () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
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
          },
        ],
        totalPnl: -500000n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display -0.5
      expect(screen.getByText(/-0\.5/)).toBeInTheDocument();
    });
  });

  describe("PORT-002: Manual refresh button", () => {
    it("should call refresh function when refresh button is clicked", async () => {
      const user = userEvent.setup({ delay: null });
      const mockRefresh = vi.fn();

      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: mockRefresh,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const refreshButton = screen.getByRole("button", { name: /Refresh/i });
      await user.click(refreshButton);

      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it("should disable refresh button while loading", () => {
      const mockRefresh = vi.fn();

      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: true,
        refresh: mockRefresh,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const refreshButton = screen.getByRole("button", { name: /Refreshing/i });
      expect(refreshButton).toBeDisabled();
    });
  });

  describe("PORT-003: Auto-refresh timer", () => {
    it("should automatically refresh every 15 seconds", async () => {
      const mockRefresh = vi.fn();

      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: mockRefresh,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      // Initially called once on mount
      expect(mockRefresh).toHaveBeenCalledTimes(0);

      // Advance time by 15 seconds
      await vi.advanceTimersByTimeAsync(15000);

      expect(mockRefresh).toHaveBeenCalledTimes(1);

      // Advance another 15 seconds
      await vi.advanceTimersByTimeAsync(15000);

      expect(mockRefresh).toHaveBeenCalledTimes(2);
    });

    it("should stop auto-refresh when wallet disconnects", async () => {
      const mockRefresh = vi.fn();

      const { rerender } = render(<PortfolioPage />);

      // Initially connected
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: mockRefresh,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      rerender(<PortfolioPage />);

      // Now disconnect
      (useWallet as any).mockReturnValue({
        connected: false,
        publicKey: null,
      });

      rerender(<PortfolioPage />);

      // Advance time - should not call refresh
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockRefresh).toHaveBeenCalledTimes(0);
    });
  });

  describe("PORT-004: Token metadata loading", () => {
    it("should show skeleton while token metadata is loading", () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
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
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      // Empty map = metadata still loading
      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      // Should show loading skeletons
      const skeletons = screen.getAllByRole("generic").filter(
        (el) => el.className.includes("animate-pulse")
      );
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it("should display position after metadata loads", () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
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
          },
        ],
        totalPnl: 0n,
        totalDeposited: 1000000n,
        loading: false,
        refresh: vi.fn(),
      });

      // Metadata loaded
      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<PortfolioPage />);

      // Should display SOL/USD
      expect(screen.getByText(/SOL\/USD/i)).toBeInTheDocument();
    });
  });

  describe("PORT-005: Empty portfolio state", () => {
    it('should show "No positions yet" message when user has no positions', () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: vi.fn(),
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      expect(screen.getByText(/No positions yet/i)).toBeInTheDocument();
      expect(screen.getByText(/Browse markets to start trading/i)).toBeInTheDocument();
    });

    it("should show Browse Markets button when empty", () => {
      (useWallet as any).mockReturnValue({
        connected: true,
        publicKey: mockPublicKey,
      });

      (usePortfolio as any).mockReturnValue({
        positions: [],
        totalPnl: 0n,
        totalDeposited: 0n,
        loading: false,
        refresh: vi.fn(),
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<PortfolioPage />);

      const browseMarketsButton = screen.getByText(/Browse Markets/i);
      expect(browseMarketsButton).toBeInTheDocument();
      expect(browseMarketsButton.closest("a")).toHaveAttribute("href", "/markets");
    });

    it("should show wallet connection prompt when not connected", () => {
      (useWallet as any).mockReturnValue({
        connected: false,
        publicKey: null,
      });

      render(<PortfolioPage />);

      expect(screen.getByText(/Connect your wallet to view positions/i)).toBeInTheDocument();
    });
  });
});
