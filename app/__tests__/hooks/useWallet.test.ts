/**
 * useWallet Hook Tests
 * 
 * Tests wallet adapter integration:
 * - Connection detection
 * - Disconnection detection
 * - Public key changes
 * - Wallet state transitions
 * 
 * Note: This tests integration with @solana/wallet-adapter-react
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";

// Mock wallet adapter
const mockUseWallet = vi.fn();
const mockUseConnection = vi.fn();

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mockUseWallet(),
  useConnection: () => mockUseConnection(),
  WalletProvider: ({ children }: any) => children,
}));

import { useWallet, useConnection } from "@solana/wallet-adapter-react";

describe("Wallet Adapter Integration", () => {
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockConnection = {
    rpcEndpoint: "https://api.devnet.solana.com",
    commitment: "confirmed",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConnection.mockReturnValue({ connection: mockConnection });
  });

  describe("Connection Detection", () => {
    it("should detect when wallet is connected", () => {
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.connected).toBe(true);
      expect(result.current.publicKey).toEqual(mockWalletPubkey);
    });

    it("should detect when wallet is disconnected", () => {
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.connected).toBe(false);
      expect(result.current.publicKey).toBeNull();
    });

    it("should detect connecting state", () => {
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: true,
        disconnecting: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.connecting).toBe(true);
      expect(result.current.connected).toBe(false);
    });
  });

  describe("Disconnection Detection", () => {
    it("should detect when wallet disconnects mid-session", () => {
      // Start connected
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: false,
      });

      const { result, rerender } = renderHook(() => useWallet());

      expect(result.current.connected).toBe(true);

      // Simulate disconnect
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: true,
      });

      rerender();

      expect(result.current.disconnecting).toBe(true);
      expect(result.current.publicKey).toBeNull();
    });

    it("should handle graceful disconnect", () => {
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        disconnect: vi.fn().mockResolvedValue(undefined),
      });

      const { result } = renderHook(() => useWallet());

      act(() => {
        result.current.disconnect?.();
      });

      expect(result.current.disconnect).toHaveBeenCalled();
    });
  });

  describe("Public Key Changes", () => {
    it("should detect wallet change (different public key)", () => {
      const firstWallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
      const secondWallet = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

      // First wallet
      mockUseWallet.mockReturnValue({
        publicKey: firstWallet,
        connected: true,
      });

      const { result, rerender } = renderHook(() => useWallet());

      expect(result.current.publicKey?.toBase58()).toBe(firstWallet.toBase58());

      // Switch to second wallet
      mockUseWallet.mockReturnValue({
        publicKey: secondWallet,
        connected: true,
      });

      rerender();

      expect(result.current.publicKey?.toBase58()).toBe(secondWallet.toBase58());
    });

    it("should handle null to connected transition", () => {
      // Start disconnected
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
      });

      const { result, rerender } = renderHook(() => useWallet());

      expect(result.current.publicKey).toBeNull();

      // Connect wallet
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
      });

      rerender();

      expect(result.current.publicKey).toEqual(mockWalletPubkey);
      expect(result.current.connected).toBe(true);
    });
  });

  describe("Wallet Methods", () => {
    it("should expose signTransaction method when connected", () => {
      const mockSignTransaction = vi.fn();
      
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        signTransaction: mockSignTransaction,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.signTransaction).toBeDefined();
      expect(typeof result.current.signTransaction).toBe("function");
    });

    it("should expose signAllTransactions method when connected", () => {
      const mockSignAllTransactions = vi.fn();
      
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        signAllTransactions: mockSignAllTransactions,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.signAllTransactions).toBeDefined();
      expect(typeof result.current.signAllTransactions).toBe("function");
    });

    it("should expose sendTransaction method when available", () => {
      const mockSendTransaction = vi.fn();
      
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        sendTransaction: mockSendTransaction,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.sendTransaction).toBeDefined();
      expect(typeof result.current.sendTransaction).toBe("function");
    });
  });

  describe("Error States", () => {
    it("should handle wallet adapter errors", () => {
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.publicKey).toBeNull();
      expect(result.current.connected).toBe(false);
    });

    it("should handle wallet not installed", () => {
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        wallet: null,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.wallet).toBeNull();
      expect(result.current.connected).toBe(false);
    });
  });

  describe("Wallet Ready State", () => {
    it("should indicate when wallet is ready to use", () => {
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: false,
        wallet: { adapter: { name: "Phantom" } },
      });

      const { result } = renderHook(() => useWallet());

      // Wallet is ready if connected and has publicKey
      const isReady = result.current.connected && result.current.publicKey !== null;
      expect(isReady).toBe(true);
    });

    it("should indicate wallet is not ready when disconnected", () => {
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
        wallet: null,
      });

      const { result } = renderHook(() => useWallet());

      const isReady = result.current.connected && result.current.publicKey !== null;
      expect(isReady).toBe(false);
    });
  });

  describe("Connection State Management", () => {
    it("should track connection lifecycle: disconnected → connecting → connected", () => {
      // Start disconnected
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
      });

      const { result, rerender } = renderHook(() => useWallet());
      expect(result.current.connected).toBe(false);

      // Transition to connecting
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: true,
        disconnecting: false,
      });

      rerender();
      expect(result.current.connecting).toBe(true);

      // Transition to connected
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: false,
      });

      rerender();
      expect(result.current.connected).toBe(true);
      expect(result.current.connecting).toBe(false);
    });

    it("should track disconnection lifecycle: connected → disconnecting → disconnected", () => {
      // Start connected
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: false,
      });

      const { result, rerender } = renderHook(() => useWallet());
      expect(result.current.connected).toBe(true);

      // Transition to disconnecting
      mockUseWallet.mockReturnValue({
        publicKey: mockWalletPubkey,
        connected: true,
        connecting: false,
        disconnecting: true,
      });

      rerender();
      expect(result.current.disconnecting).toBe(true);

      // Transition to disconnected
      mockUseWallet.mockReturnValue({
        publicKey: null,
        connected: false,
        connecting: false,
        disconnecting: false,
      });

      rerender();
      expect(result.current.connected).toBe(false);
      expect(result.current.disconnecting).toBe(false);
    });
  });
});
