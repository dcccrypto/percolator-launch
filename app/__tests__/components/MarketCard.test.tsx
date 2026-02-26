/**
 * MarketBrowser Component Tests
 * Tests: MKT-001, MKT-002, MKT-003, MKT-004, MKT-005
 * 
 * MKT-001: Debounced search
 * MKT-002: URL param persistence
 * MKT-003: Infinite scroll pagination
 * MKT-004: Sort with null values
 * MKT-005: Clear search button
 * 
 * Note: MarketBrowser currently doesn't have search/filter/infinite scroll
 * These tests are prepared for when those features are added, and test
 * the current functionality of displaying markets and handling edge cases
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketBrowser } from "@/components/market/MarketBrowser";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import type { DiscoveredMarket } from "@percolator/sdk";

// Mock Next.js
vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

// Mock hooks
vi.mock("@/hooks/useMarketDiscovery");
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/components/market/HealthBadge", () => ({
  HealthBadge: ({ level }: any) => <span data-testid="health-badge">{level}</span>,
}));
vi.mock("@/lib/health", () => ({
  computeMarketHealth: (engine: any) => ({
    level: engine?.vault > 1000000n ? "healthy" : "warning",
  }),
  sanitizeAccountCount: (count: number) => (count > 4096 || count < 0 ? 0 : count),
}));

const mockPublicKey = new PublicKey("11111111111111111111111111111111");

const createMockMarket = (overrides?: Partial<DiscoveredMarket>): DiscoveredMarket => ({
  slabAddress: mockPublicKey,
  programId: mockPublicKey,
  header: {
    magic: 0x504552434f4c4154n,
    version: 1,
    bump: 0,
    flags: 0,
    resolved: false,
    paused: false,
    admin: mockPublicKey,
    nonce: 0n,
    lastThrUpdateSlot: 0n,
    ...overrides?.header,
  } as any,
  config: {
    collateralMint: mockPublicKey,
    vaultPubkey: mockPublicKey,
    indexFeedId: mockPublicKey,
    maxStalenessSlots: 60n,
    confFilterBps: 100,
    vaultAuthorityBump: 0,
    invert: 0,
    unitScale: 0,
    fundingHorizonSlots: 3600n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1000000n,
    fundingMaxPremiumBps: 500n,
    fundingMaxBpsPerSlot: 10n,
    threshFloor: 1000n,
    threshRiskBps: 500n,
    threshUpdateIntervalSlots: 100n,
    threshStepBps: 50n,
    threshAlphaBps: 100n,
    threshMin: 500n,
    threshMax: 5000n,
    threshMinStep: 10n,
    oracleAuthority: mockPublicKey,
    authorityPriceE6: 0n,
    authorityTimestamp: 0n,
    oraclePriceCapE2bps: 0n,
    lastEffectivePriceE6: 0n,
    ...overrides?.config,
  },
  engine: {
    vault: 10000000n,
    totalOpenInterest: 5000000n,
    insuranceFund: {
      balance: 1000000n,
      feeRevenue: 0n,
    },
    currentSlot: 1000n,
    fundingIndexQpbE6: 0n,
    lastFundingSlot: 0n,
    fundingRateBpsPerSlotLast: 0n,
    lastCrankSlot: 0n,
    maxCrankStalenessSlots: 100n,
    cTot: 0n,
    pnlPosTot: 0n,
    liqCursor: 0,
    gcCursor: 0,
    lastSweepStartSlot: 0n,
    lastSweepCompleteSlot: 0n,
    crankCursor: 0,
    sweepStartIdx: 0,
    lifetimeLiquidations: 0n,
    lifetimeForceCloses: 0n,
    netLpPos: 0n,
    lpSumAbs: 0n,
    lpMaxAbs: 0n,
    lpMaxAbsSweep: 0n,
    numUsedAccounts: 42,
    nextAccountId: 0n,
    ...overrides?.engine,
  },
  params: {
    warmupPeriodSlots: 100n,
    maintenanceMarginBps: 500n,
    initialMarginBps: 1000n,
    tradingFeeBps: 10n,
    maxAccounts: 100n,
    ...overrides?.params,
  } as any,
  ...overrides,
} as DiscoveredMarket);

describe("MarketBrowser Component Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MKT-001: Debounced search (Future Feature)", () => {
    it("should render markets without search for now", () => {
      const mockMarkets = [createMockMarket()];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      // Should display market
      expect(screen.getByText(/SOL\/USD PERP/i)).toBeInTheDocument();
    });

    // Placeholder for future search debouncing test
    it.skip("should debounce search input by 300ms", async () => {
      // This test will be implemented when search is added
      // Expected behavior: type fast → wait 300ms → single API call
    });
  });

  describe("MKT-002: URL param persistence (Future Feature)", () => {
    it("should display markets without URL filters for now", () => {
      const mockMarkets = [createMockMarket()];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      expect(screen.getByText(/SOL\/USD PERP/i)).toBeInTheDocument();
    });

    // Placeholder for future URL persistence test
    it.skip("should persist filter state in URL params", () => {
      // This test will be implemented when filters are added
      // Expected: filter applied → URL updates → page refresh → filter persists
    });
  });

  describe("MKT-003: Infinite scroll pagination (Future Feature)", () => {
    it("should display all markets without pagination for now", () => {
      const mockMarkets = [
        createMockMarket({ slabAddress: new PublicKey("11111111111111111111111111111111") }),
        createMockMarket({ slabAddress: new PublicKey("2kVU3naG2r4kezerqcuDB6nadtd7vmyeRTsqcbWBTscb") }),
        createMockMarket({ slabAddress: new PublicKey("8rxVYS7HdWpmqGgNPTCZXTqGATZLde9Lv5e9kaUrZGCQ") }),
      ];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      const rows = screen.getAllByRole("row");
      // Header + 3 market rows
      expect(rows.length).toBe(4);
    });

    // Placeholder for future infinite scroll test
    it.skip("should load more markets on scroll", async () => {
      // This test will be implemented when infinite scroll is added
      // Expected: scroll to bottom → wait → next 20 markets loaded
    });
  });

  describe("MKT-004: Sort with null values (CRITICAL)", () => {
    it("should handle markets with null/zero values without crashing", () => {
      const market1 = createMockMarket({});
      market1.engine.vault = 0n; // Zero vault
      market1.engine.totalOpenInterest = 0n;
      market1.engine.insuranceFund = { balance: 0n, feeRevenue: 0n };
      market1.engine.numUsedAccounts = 0;
      
      const market2 = createMockMarket({});
      market2.engine.vault = 10000000n;
      market2.engine.totalOpenInterest = 5000000n;
      market2.engine.insuranceFund = { balance: 1000000n, feeRevenue: 0n };
      market2.engine.numUsedAccounts = 42;
      
      const mockMarkets = [market1, market2];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      // Should render both markets without crashing
      const rows = screen.getAllByRole("row");
      expect(rows.length).toBe(3); // Header + 2 markets
    });

    it("should sort markets by health level correctly", () => {
      const market1 = createMockMarket({
        slabAddress: new PublicKey("4FJ3MMh1MQMP1dSUiRmwF1P7b69HPmEjW42dxpbXNcpM"),
      });
      market1.engine.vault = 100n; // Low vault = warning
      market1.engine.totalOpenInterest = 0n;
      market1.engine.insuranceFund = { balance: 0n, feeRevenue: 0n };
      market1.engine.numUsedAccounts = 0;
      
      const market2 = createMockMarket({
        slabAddress: new PublicKey("7Q5yyfpxSybsCqoKZL4TJkyXCZCmQDSm6cH3fjxDCuam"),
      });
      market2.engine.vault = 10000000n; // High vault = healthy
      market2.engine.totalOpenInterest = 5000000n;
      market2.engine.insuranceFund = { balance: 1000000n, feeRevenue: 0n };
      market2.engine.numUsedAccounts = 42;
      
      const mockMarkets = [market1, market2];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      const healthBadges = screen.getAllByTestId("health-badge");
      // Healthy should come first
      expect(healthBadges[0]).toHaveTextContent("healthy");
      expect(healthBadges[1]).toHaveTextContent("warning");
    });

    it("should handle missing metadata gracefully", () => {
      const mockMarkets = [createMockMarket()];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      // Empty metadata map
      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<MarketBrowser />);

      // Should show shortened address when symbol is not available
      expect(screen.getByText(/1111\.\.\.1111\/USD PERP/i)).toBeInTheDocument();
    });
  });

  describe("MKT-005: Clear search button (Future Feature)", () => {
    it("should display markets without search functionality for now", () => {
      const mockMarkets = [createMockMarket()];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      expect(screen.getByText(/SOL\/USD PERP/i)).toBeInTheDocument();
    });

    // Placeholder for future clear search test
    it.skip("should clear search input and show all markets", async () => {
      // This test will be implemented when search is added
      // Expected: search "BTC" → click clear → search input empty, all markets shown
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should show loading state", () => {
      (useMarketDiscovery as any).mockReturnValue({
        markets: [],
        loading: true,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<MarketBrowser />);

      expect(screen.getByText(/Discovering markets/i)).toBeInTheDocument();
    });

    it("should show error state with helpful message", () => {
      (useMarketDiscovery as any).mockReturnValue({
        markets: [],
        loading: false,
        error: "PROGRAM_ID not configured",
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<MarketBrowser />);

      expect(screen.getByText(/Error:/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Set the NEXT_PUBLIC_PROGRAM_ID environment variable/i)
      ).toBeInTheDocument();
    });

    it("should show empty state when no markets exist", () => {
      (useMarketDiscovery as any).mockReturnValue({
        markets: [],
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(new Map());

      render(<MarketBrowser />);

      expect(screen.getByText(/No markets found/i)).toBeInTheDocument();
    });

    it("should display market stats correctly", () => {
      const market = createMockMarket({});
      market.engine.vault = 10000000n;
      market.engine.totalOpenInterest = 5000000n; // 5 SOL
      market.engine.insuranceFund = { balance: 1000000n, feeRevenue: 0n }; // 1 SOL
      market.engine.numUsedAccounts = 42;
      
      const mockMarkets = [market];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      // Check Open Interest
      expect(screen.getByText(/5 SOL/i)).toBeInTheDocument();
      // Check Insurance Fund
      expect(screen.getByText(/1 SOL/i)).toBeInTheDocument();
      // Check Account Count
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("should render trade link with correct href", () => {
      const slabKey = new PublicKey("EfgWMhW4VeL1CyP8nvkmsXduF1Uf9KmRgy6F1c3GEyWr");
      const mockMarkets = [
        createMockMarket({
          slabAddress: slabKey,
        }),
      ];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      const tradeLink = screen.getByRole("link", { name: /Trade/i });
      expect(tradeLink).toHaveAttribute("href", `/trade/${slabKey.toBase58()}`);
    });
  });

  describe("Oracle Type Badge", () => {
    it("should show Admin badge for zero oracle feed ID", () => {
      const zeroKey = new PublicKey("11111111111111111111111111111111");
      const market = createMockMarket({});
      market.config.indexFeedId = zeroKey; // Admin oracle
      const mockMarkets = [market];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      expect(screen.getByText("Admin")).toBeInTheDocument();
    });

    it("should show Pyth badge for non-zero oracle feed ID", () => {
      const pythKey = new PublicKey("2kVU3naG2r4kezerqcuDB6nadtd7vmyeRTsqcbWBTscb");
      const market = createMockMarket({});
      market.config.indexFeedId = pythKey; // Pyth oracle
      const mockMarkets = [market];

      (useMarketDiscovery as any).mockReturnValue({
        markets: mockMarkets,
        loading: false,
        error: null,
      });

      (useMultiTokenMeta as any).mockReturnValue(
        new Map([[mockPublicKey.toBase58(), { symbol: "SOL", decimals: 6 }]])
      );

      render(<MarketBrowser />);

      expect(screen.getByText("Pyth")).toBeInTheDocument();
    });
  });
});
