/**
 * useWalletCompat Hook Tests
 * 
 * Tests Privy wallet compatibility layer:
 * - Connection detection
 * - Disconnection detection
 * - Public key derivation
 * - Wallet state transitions
 * 
 * Note: This tests integration with @privy-io/react-auth via useWalletCompat
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

// Mock Privy hooks
const mockUsePrivy = vi.fn();
const mockUseWallets = vi.fn();
const mockUseSignTransaction = vi.fn();

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => mockUsePrivy(),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => mockUseWallets(),
  useSignTransaction: () => mockUseSignTransaction(),
}));

vi.mock("@/hooks/usePrivySafe", () => ({
  usePrivyAvailable: () => true,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://example.com/api/rpc",
    network: "devnet",
    programId: "test",
  }),
  getWsEndpoint: () => undefined,
  getRpcEndpoint: () => "https://example.com/api/rpc",
}));

import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";

describe("useWalletCompat", () => {
  const mockAddress = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSignTransaction.mockReturnValue({ signTransaction: vi.fn() });
  });

  describe("Connection State", () => {
    it("should report connected=false when not authenticated", () => {
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: false, user: null, logout: vi.fn() });
      mockUseWallets.mockReturnValue({ wallets: [] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.connected).toBe(false);
      expect(result.current.publicKey).toBeNull();
    });

    it("should report connected=true when authenticated with wallet", () => {
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, user: { id: "1" }, logout: vi.fn() });
      mockUseWallets.mockReturnValue({ wallets: [{ address: mockAddress, standardWallet: { name: "Phantom" } }] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.connected).toBe(true);
      expect(result.current.publicKey).toEqual(new PublicKey(mockAddress));
    });

    it("should report connecting=true when Privy is not ready", () => {
      mockUsePrivy.mockReturnValue({ ready: false, authenticated: false, user: null, logout: vi.fn() });
      mockUseWallets.mockReturnValue({ wallets: [] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.connecting).toBe(true);
    });

    it("should report connecting=false when Privy is ready", () => {
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: false, user: null, logout: vi.fn() });
      mockUseWallets.mockReturnValue({ wallets: [] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.connecting).toBe(false);
    });

    it("should return null publicKey when no wallets connected", () => {
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, user: { id: "1" }, logout: vi.fn() });
      mockUseWallets.mockReturnValue({ wallets: [] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.publicKey).toBeNull();
      expect(result.current.connected).toBe(false);
    });

    it("should prefer external wallet over embedded (Privy) wallet", () => {
      const externalAddr = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, user: { id: "1" }, logout: vi.fn() });
      mockUseWallets.mockReturnValue({
        wallets: [
          { address: mockAddress, standardWallet: { name: "Privy" } },
          { address: externalAddr, standardWallet: { name: "Phantom" } },
        ],
      });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.publicKey?.toBase58()).toBe(externalAddr);
    });

    it("should fall back to embedded wallet when no external wallet", () => {
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, user: { id: "1" }, logout: vi.fn() });
      mockUseWallets.mockReturnValue({
        wallets: [{ address: mockAddress, standardWallet: { name: "Privy" } }],
      });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.publicKey?.toBase58()).toBe(mockAddress);
    });
  });

  describe("Disconnect", () => {
    it("should expose logout as disconnect", () => {
      const mockLogout = vi.fn();
      mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, user: { id: "1" }, logout: mockLogout });
      mockUseWallets.mockReturnValue({ wallets: [{ address: mockAddress, standardWallet: { name: "Phantom" } }] });

      const { result } = renderHook(() => useWalletCompat());
      expect(result.current.disconnect).toBe(mockLogout);
    });
  });
});

describe("useConnectionCompat", () => {
  it("should use the configured RPC endpoint", () => {
    const { result } = renderHook(() => useConnectionCompat());
    expect((result.current.connection as any)._rpcEndpoint).toBe("https://example.com/api/rpc");
  });
});
