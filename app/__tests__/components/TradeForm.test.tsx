/**
 * TradeForm Component Tests
 * Tests: TRADE-005, TRADE-006, TRADE-007
 * 
 * TRADE-005: BigInt price formatting
 * TRADE-006: MAX button uses full balance
 * TRADE-007: Invalid amount rejected
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TradeForm } from "@/components/trade/TradeForm";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { AccountKind } from "@percolator/core";
import { PublicKey } from "@solana/web3.js";

// Mock all hooks
vi.mock("@solana/wallet-adapter-react");
vi.mock("@/hooks/useTrade");
vi.mock("@/hooks/useUserAccount");
vi.mock("@/hooks/useEngineState");
vi.mock("@/components/providers/SlabProvider");
vi.mock("@/hooks/useTokenMeta");
vi.mock("@/hooks/useLivePrice");
vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => true,
}));

const mockPublicKey = new PublicKey("11111111111111111111111111111111");

describe("TradeForm Component Tests", () => {
  const mockTrade = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock implementations
    (useWallet as any).mockReturnValue({
      connected: true,
      publicKey: mockPublicKey,
    });
    
    (useTrade as any).mockReturnValue({
      trade: mockTrade,
      loading: false,
      error: null,
    });
    
    (useEngineState as any).mockReturnValue({
      engine: {
        vault: 100000000000n, // 100k tokens
      },
      params: {
        riskReductionThreshold: 0n,
        initialMarginBps: 1000n, // 10% = 10x max leverage
        maintenanceMarginBps: 500n,
        tradingFeeBps: 30n,
      },
    });
    
    (useSlabState as any).mockReturnValue({
      accounts: [
        {
          idx: 0,
          account: {
            kind: AccountKind.LP,
          },
        },
      ],
      config: {
        collateralMint: mockPublicKey,
      },
      header: {
        paused: false,
      },
    });
    
    (useTokenMeta as any).mockReturnValue({
      symbol: "SOL",
      decimals: 6,
    });
    
    (useLivePrice as any).mockReturnValue({
      priceUsd: 100,
    });
  });
  
  describe("TRADE-005: BigInt price formatting", () => {
    it("should format large BigInt values correctly", () => {
      const capital = 123456789012345678n;
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      // Check that balance is displayed with proper formatting
      // 123456789012345678n with 6 decimals = 123456789012.345678
      const balanceText = screen.getByText(/Balance:/i);
      expect(balanceText.textContent).toContain("123456789012.345678");
    });
    
    it("should handle zero BigInt values", () => {
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital: 0n,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const balanceText = screen.getByText(/Balance:/i);
      expect(balanceText.textContent).toContain("0");
    });
    
    it("should handle decimal precision correctly", () => {
      const capital = 1500000n; // 1.5 SOL with 6 decimals
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const balanceText = screen.getByText(/Balance:/i);
      expect(balanceText.textContent).toContain("1.5");
    });
  });
  
  describe("TRADE-006: MAX button uses full balance", () => {
    it("should populate input with full balance when MAX is clicked", async () => {
      const user = userEvent.setup();
      const capital = 5000000n; // 5 SOL
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const maxButton = screen.getByRole("button", { name: /max/i });
      const input = screen.getByPlaceholderText("0.00");
      
      await user.click(maxButton);
      
      expect(input).toHaveValue("5");
    });
    
    it("should not set value if balance is zero", async () => {
      const user = userEvent.setup();
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital: 0n,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const maxButton = screen.getByRole("button", { name: /max/i });
      const input = screen.getByPlaceholderText("0.00");
      
      await user.click(maxButton);
      
      expect(input).toHaveValue("");
    });
    
    it("should handle balance with decimals correctly", async () => {
      const user = userEvent.setup();
      const capital = 1234567n; // 1.234567 SOL
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const maxButton = screen.getByRole("button", { name: /max/i });
      const input = screen.getByPlaceholderText("0.00");
      
      await user.click(maxButton);
      
      expect(input).toHaveValue("1.234567");
    });
  });
  
  describe("TRADE-007: Invalid amount rejected", () => {
    beforeEach(() => {
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital: 10000000n, // 10 SOL
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
    });
    
    it("should reject alphabetic characters in input", async () => {
      const user = userEvent.setup();
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      
      await user.type(input, "abc");
      
      // Input should filter out non-numeric characters
      expect(input).toHaveValue("");
    });
    
    it("should reject special characters except decimal point", async () => {
      const user = userEvent.setup();
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      
      await user.type(input, "1@#$2");
      
      // Only numeric characters should remain
      expect(input).toHaveValue("12");
    });
    
    it("should allow valid decimal numbers", async () => {
      const user = userEvent.setup();
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      
      await user.type(input, "5.5");
      
      expect(input).toHaveValue("5.5");
    });
    
    it("should show error when amount exceeds balance", async () => {
      const user = userEvent.setup();
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      
      await user.type(input, "100"); // More than 10 SOL balance
      
      // Should show exceeds balance error
      await waitFor(() => {
        expect(screen.getByText(/Exceeds balance/i)).toBeInTheDocument();
      });
    });
    
    it("should disable submit button when input is invalid", async () => {
      const user = userEvent.setup();
      
      render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      const submitButton = screen.getByRole("button", { name: /Long 1x/i });
      
      // Empty input should disable button
      expect(submitButton).toBeDisabled();
      
      // Valid input should enable button
      await user.type(input, "5");
      await waitFor(() => {
        expect(submitButton).not.toBeDisabled();
      });
      
      // Clear input should disable again
      await user.clear(input);
      await waitFor(() => {
        expect(submitButton).toBeDisabled();
      });
    });
  });
  
  describe("Critical: TRADE-002 - Wallet disconnect handling", () => {
    it("should show error if wallet disconnects before trade submission", async () => {
      const user = userEvent.setup();
      
      (useUserAccount as any).mockReturnValue({
        idx: 1,
        account: {
          kind: AccountKind.User,
          owner: mockPublicKey,
          capital: 10000000n,
          positionSize: 0n,
          pnl: 0n,
          entryPrice: 0n,
        },
      });
      
      const { rerender } = render(<TradeForm slabAddress="test-slab" />);
      
      const input = screen.getByPlaceholderText("0.00");
      await user.type(input, "5");
      
      // Simulate wallet disconnect
      (useWallet as any).mockReturnValue({
        connected: false,
        publicKey: null,
      });
      
      rerender(<TradeForm slabAddress="test-slab" />);
      
      // Try to submit
      const submitButton = screen.getByRole("button", { name: /Long 1x/i });
      await user.click(submitButton);
      
      // Should show wallet disconnect error
      await waitFor(() => {
        expect(screen.getByText(/Wallet disconnected/i)).toBeInTheDocument();
      });
      
      // Trade should not be called
      expect(mockTrade).not.toHaveBeenCalled();
    });
  });
});
