/**
 * useStuckSlabs Hook Tests
 *
 * Covers the in-flight market recovery path that backs RecoverSolBanner:
 * - the wallet gate (nothing surfaces for a disconnected wallet)
 * - the admin-address filter (another tab's / another wallet's market never leaks)
 * - on-chain classification (missing / uninitialised / v12 / v17)
 * - clearStuck against the real `percolator:in-flight-market:` storage contract
 *
 * These previously asserted a single `percolator-pending-slab-keypair`
 * localStorage key. That contract was replaced by `lib/inFlightMarket`'s
 * per-slab keys + wallet gate (W7), so the old suite exercised a code path the
 * hook no longer has. It is rewritten here against the current contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";

// ─── Mocks ───

const mockGetAccountInfo = vi.fn();

// IMPORTANT: the connection object must be a STABLE reference,
// otherwise useCallback deps cycle and the hook never settles.
const stableConnection = { getAccountInfo: mockGetAccountInfo };

// Mutable wallet identity — the hook gates every read on `wallet.publicKey`,
// so each test sets this to the wallet it wants to be "connected" as.
let mockWalletPublicKey: { toBase58: () => string } | null = null;

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: stableConnection }),
  useWalletCompat: () => ({ publicKey: mockWalletPublicKey }),
}));

// The hook only uses the SDK for the v17 magic check; stub it so these tests
// stay about the hook's own classification logic and never load the SDK.
const mockIsV17Account = vi.fn(() => false);
vi.mock("@percolatorct/sdk", () => ({
  isV17Account: (data: Uint8Array) => mockIsV17Account(data),
}));

// jsdom's localStorage is not a full Storage in this setup, and
// `loadAllInFlightMarkets()` iterates it via `length` + `key(i)` — so stub a
// complete Storage-shaped object rather than relying on the environment.
const storageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string): string | null => storageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storageStore[key];
  }),
  clear: vi.fn(() => {
    Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  }),
  get length() {
    return Object.keys(storageStore).length;
  },
  key: vi.fn((i: number) => Object.keys(storageStore)[i] ?? null),
};
vi.stubGlobal("localStorage", mockLocalStorage);

// Must import AFTER mocks
import { useStuckSlabs } from "@/hooks/useStuckSlabs";
import { saveInFlightMarket, type InFlightMarketState } from "@/lib/inFlightMarket";

// ─── Helpers ───

const PROGRAM_ID = "5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf";

/** Wallet the tests are "connected" as unless a test says otherwise. */
const walletKp = Keypair.generate();
const WALLET = walletKp.publicKey.toBase58();

/**
 * Persists one in-flight market through the real `lib/inFlightMarket` writer,
 * so the test depends on the same storage contract production code writes.
 */
function persistInFlight(
  overrides: Partial<InFlightMarketState> = {},
): { state: InFlightMarketState; keypair: Keypair } {
  const slabKp = Keypair.generate();
  const state: InFlightMarketState = {
    slabAddress: slabKp.publicKey.toBase58(),
    slabSecretKey: Array.from(slabKp.secretKey),
    adminAddress: WALLET,
    collateralAta: Keypair.generate().publicKey.toBase58(),
    collateralMint: Keypair.generate().publicKey.toBase58(),
    programId: PROGRAM_ID,
    network: "devnet",
    createdAt: 1_700_000_000_000,
    lastStep: 1,
    ...overrides,
  };
  saveInFlightMarket(state);
  return { state, keypair: slabKp };
}

/** Account data whose first 8 bytes are the v12 "PERCOLAT" magic. */
function v12AccountData(): Buffer {
  const data = Buffer.alloc(1024);
  data.writeBigUInt64LE(0x504552434f4c4154n, 0);
  return data;
}

function accountInfo(data: Buffer, lamports: number) {
  return {
    data,
    lamports,
    owner: { toBase58: () => PROGRAM_ID },
  };
}

// ─── Tests ───

describe("useStuckSlabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetAccountInfo.mockReset();
    mockIsV17Account.mockReturnValue(false);
    mockWalletPublicKey = walletKp.publicKey;
  });

  describe("wallet gate", () => {
    it("returns nothing when no wallet is connected", async () => {
      mockWalletPublicKey = null;
      persistInFlight();

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab).toBeNull();
      expect(result.current.stuckSlabs).toEqual([]);
      // Gated before any RPC — a disconnected wallet must not trigger lookups.
      expect(mockGetAccountInfo).not.toHaveBeenCalled();
    });

    it("ignores in-flight markets belonging to a different wallet", async () => {
      const otherWallet = Keypair.generate().publicKey.toBase58();
      persistInFlight({ adminAddress: otherWallet });

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlabs).toEqual([]);
      expect(mockGetAccountInfo).not.toHaveBeenCalled();
    });

    it("returns nothing when there are no persisted in-flight markets", async () => {
      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab).toBeNull();
      expect(result.current.stuckSlabs).toEqual([]);
    });
  });

  describe("on-chain classification", () => {
    it("detects a non-existent account (atomic rollback)", async () => {
      const { keypair } = persistInFlight();
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const slab = result.current.stuckSlab;
      expect(slab).not.toBeNull();
      expect(slab!.exists).toBe(false);
      expect(slab!.isInitialized).toBe(false);
      expect(slab!.lamports).toBe(0);
      expect(slab!.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    });

    it("reconstructs the slab keypair from the persisted secret", async () => {
      const { keypair } = persistInFlight();
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      // The reclaim path (tag 52) signs with this key — losing it means the
      // rent is unrecoverable from the UI.
      expect(result.current.stuckSlab!.keypair).not.toBeNull();
      expect(result.current.stuckSlab!.keypair!.publicKey.toBase58()).toBe(
        keypair.publicKey.toBase58(),
      );
    });

    it("detects an initialized v12 slab (partial completion)", async () => {
      persistInFlight();
      mockGetAccountInfo.mockResolvedValue(accountInfo(v12AccountData(), 2_000_000_000));

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab!.exists).toBe(true);
      expect(result.current.stuckSlab!.isInitialized).toBe(true);
      expect(result.current.stuckSlab!.lamports).toBe(2_000_000_000);
      expect(result.current.stuckSlab!.owner).toBe(PROGRAM_ID);
    });

    it("detects an initialized v17 slab via the SDK magic check", async () => {
      persistInFlight();
      mockIsV17Account.mockReturnValue(true);
      mockGetAccountInfo.mockResolvedValue(accountInfo(Buffer.alloc(1024, 0), 2_000_000_000));

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab!.isInitialized).toBe(true);
    });

    it("detects an uninitialized slab (rare stuck state)", async () => {
      persistInFlight();
      mockGetAccountInfo.mockResolvedValue(accountInfo(Buffer.alloc(1024, 0), 1_500_000_000));

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab!.exists).toBe(true);
      expect(result.current.stuckSlab!.isInitialized).toBe(false);
      expect(result.current.stuckSlab!.lamports).toBe(1_500_000_000);
    });

    it("handles an account smaller than the magic without crashing", async () => {
      persistInFlight();
      mockGetAccountInfo.mockResolvedValue(accountInfo(Buffer.alloc(4, 0), 500_000));

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlab!.exists).toBe(true);
      expect(result.current.stuckSlab!.isInitialized).toBe(false);
    });
  });

  describe("resilience", () => {
    it("skips malformed persisted entries instead of throwing", async () => {
      window.localStorage.setItem(
        "percolator:in-flight-market:bogus",
        "not valid json",
      );

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlabs).toEqual([]);
    });

    it("keeps the last-good list when a later RPC lookup fails", async () => {
      // Must seed a SUCCESSFUL load first. Asserting an empty list straight
      // after a failed initial mount proves nothing — it is empty either way,
      // whether the catch preserves state or blanks it.
      const { state } = persistInFlight();
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.stuckSlabs).toHaveLength(1));

      // Now break the RPC and force a refresh.
      mockGetAccountInfo.mockRejectedValue(new Error("RPC connection failed"));
      await act(async () => {
        await result.current.refresh();
      });

      // A transient RPC error must not blank the recovery banner — the user
      // would lose sight of a market still holding their rent.
      expect(result.current.stuckSlabs).toHaveLength(1);
      expect(result.current.stuckSlab!.publicKey.toBase58()).toBe(state.slabAddress);
      expect(result.current.loading).toBe(false);
    });
  });

  describe("ordering and clearing", () => {
    it("surfaces every stuck market for the wallet, most recent first", async () => {
      const older = persistInFlight({ createdAt: 1_700_000_000_000 });
      const newer = persistInFlight({ createdAt: 1_700_000_999_000 });
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.stuckSlabs).toHaveLength(2);
      expect(result.current.stuckSlabs[0].publicKey.toBase58()).toBe(
        newer.state.slabAddress,
      );
      expect(result.current.stuckSlabs[1].publicKey.toBase58()).toBe(
        older.state.slabAddress,
      );
      // `stuckSlab` (singular) stays the most-recent entry for old callers.
      expect(result.current.stuckSlab!.publicKey.toBase58()).toBe(newer.state.slabAddress);
    });

    it("clearStuck() with no argument clears only the most-recent entry", async () => {
      const older = persistInFlight({ createdAt: 1_700_000_000_000 });
      const newer = persistInFlight({ createdAt: 1_700_000_999_000 });
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.clearStuck();
      });

      expect(
        window.localStorage.getItem(`percolator:in-flight-market:${newer.state.slabAddress}`),
      ).toBeNull();
      expect(
        window.localStorage.getItem(`percolator:in-flight-market:${older.state.slabAddress}`),
      ).not.toBeNull();
      expect(result.current.stuckSlabs).toHaveLength(1);
      expect(result.current.stuckSlab!.publicKey.toBase58()).toBe(older.state.slabAddress);
    });

    it("clearStuck(address) clears the addressed entry", async () => {
      const older = persistInFlight({ createdAt: 1_700_000_000_000 });
      const newer = persistInFlight({ createdAt: 1_700_000_999_000 });
      mockGetAccountInfo.mockResolvedValue(null);

      const { result } = renderHook(() => useStuckSlabs());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.clearStuck(older.state.slabAddress);
      });

      expect(
        window.localStorage.getItem(`percolator:in-flight-market:${older.state.slabAddress}`),
      ).toBeNull();
      expect(result.current.stuckSlabs).toHaveLength(1);
      expect(result.current.stuckSlab!.publicKey.toBase58()).toBe(newer.state.slabAddress);
    });
  });
});
