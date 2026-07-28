import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

// ─── Mocks ───

const mockGetAccountInfo = vi.fn();

// IMPORTANT: the connection object must be a STABLE reference,
// otherwise useCallback deps cycle and the hook never settles.
const stableConnection = { getAccountInfo: mockGetAccountInfo };

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: stableConnection }),
  // useStuckSlabs also calls useWalletCompat() (it scopes stuck slabs to the
  // connected wallet). A vi.mock factory REPLACES the whole module, so omitting
  // this made every render throw "No useWalletCompat export is defined".
  useWalletCompat: () => ({ publicKey: MOCK_WALLET, connected: true }),
}));

// The hook scopes stuck slabs to the CONNECTED wallet, so fixtures must be
// attributed to one or they are filtered out.
const MOCK_WALLET = Keypair.generate().publicKey;

// Mock localStorage
const storageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string): string | null => storageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { storageStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete storageStore[key]; }),
  clear: vi.fn(() => { Object.keys(storageStore).forEach(k => delete storageStore[k]); }),
  get length() { return Object.keys(storageStore).length; },
  key: vi.fn((i: number) => Object.keys(storageStore)[i] ?? null),
};
vi.stubGlobal("localStorage", mockLocalStorage);

// Must import AFTER mocks
import { useStuckSlabs } from "@/hooks/useStuckSlabs";

// ─── Helpers ───

/**
 * Write an in-flight market entry the way lib/inFlightMarket.ts does.
 *
 * These tests used to write the LEGACY single-keypair blob
 * (`percolator-pending-slab-keypair` = a bare secretKey array). The hook moved
 * to wallet-scoped entries — `loadAllInFlightMarkets()` filtered by
 * `adminAddress === connectedWallet` — so the legacy fixture matched nothing and
 * every assertion saw an empty list. Writing the real shape is what makes these
 * tests exercise the recovery path again instead of the empty path.
 */
function persistKeypair(admin: PublicKey = MOCK_WALLET): Keypair {
  const kp = Keypair.generate();
  const slabAddress = kp.publicKey.toBase58();
  const state = {
    slabAddress,
    slabSecretKey: Array.from(kp.secretKey),
    adminAddress: admin.toBase58(),
    collateralAta: PublicKey.default.toBase58(),
    collateralMint: PublicKey.default.toBase58(),
    programId: PublicKey.default.toBase58(),
    network: "devnet" as const,
    createdAt: Date.now(),
    lastStep: 1,
  };
  storageStore[`percolator:in-flight-market:${slabAddress}`] = JSON.stringify(state);
  storageStore["percolator:last-in-flight-key"] = `percolator:in-flight-market:${slabAddress}`;
  return kp;
}

function clearStorage() {
  Object.keys(storageStore).forEach(k => delete storageStore[k]);
}

// ─── Tests ───

describe("useStuckSlabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStorage();
    mockGetAccountInfo.mockReset();
  });

  it("returns null when no pending keypair in localStorage", async () => {
    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stuckSlab).toBeNull();
  });

  it("detects non-existent account (atomic rollback)", async () => {
    const kp = persistKeypair();
    mockGetAccountInfo.mockResolvedValue(null);

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).not.toBeNull();
    expect(result.current.stuckSlab!.exists).toBe(false);
    expect(result.current.stuckSlab!.isInitialized).toBe(false);
    expect(result.current.stuckSlab!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("detects initialized slab (partial completion)", async () => {
    persistKeypair();
    const data = Buffer.alloc(1024);
    data.writeBigUInt64LE(0x504552434f4c4154n, 0); // "PERCOLAT"

    mockGetAccountInfo.mockResolvedValue({
      data,
      lamports: 2_000_000_000,
      owner: { toBase58: () => "ProgramId111111111111111111111111111111111" },
    });

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).not.toBeNull();
    expect(result.current.stuckSlab!.exists).toBe(true);
    expect(result.current.stuckSlab!.isInitialized).toBe(true);
    expect(result.current.stuckSlab!.lamports).toBe(2_000_000_000);
  });

  it("detects uninitialized slab (rare stuck state)", async () => {
    persistKeypair();
    const data = Buffer.alloc(1024, 0);

    mockGetAccountInfo.mockResolvedValue({
      data,
      lamports: 1_500_000_000,
      owner: { toBase58: () => "ProgramId111111111111111111111111111111111" },
    });

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).not.toBeNull();
    expect(result.current.stuckSlab!.exists).toBe(true);
    expect(result.current.stuckSlab!.isInitialized).toBe(false);
    expect(result.current.stuckSlab!.lamports).toBe(1_500_000_000);
  });

  it("handles corrupted localStorage data gracefully", async () => {
    storageStore["percolator:in-flight-market:bogus"] = "not valid json";

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A corrupted entry must be ignored, not crash the banner. (It used to
    // assert removal of the legacy `percolator-pending-slab-keypair`; entries
    // are now per-slab keys, and an unparseable one is simply skipped.)
    expect(result.current.stuckSlab).toBeNull();
  });

  it("handles RPC errors gracefully", async () => {
    persistKeypair();
    mockGetAccountInfo.mockRejectedValue(new Error("RPC connection failed"));

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).toBeNull();
  });

  it("clearStuck removes the in-flight entry for that slab", async () => {
    const kp = persistKeypair();
    mockGetAccountInfo.mockResolvedValue(null);

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.clearStuck();
    });

    // Per-slab key, not the retired global one.
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith(
      `percolator:in-flight-market:${kp.publicKey.toBase58()}`,
    );
    expect(result.current.stuckSlab).toBeNull();
  });

  it("handles small data buffer without crash", async () => {
    persistKeypair();
    const data = Buffer.alloc(4, 0);

    mockGetAccountInfo.mockResolvedValue({
      data,
      lamports: 500_000,
      owner: { toBase58: () => "ProgramId111111111111111111111111111111111" },
    });

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).not.toBeNull();
    expect(result.current.stuckSlab!.exists).toBe(true);
    expect(result.current.stuckSlab!.isInitialized).toBe(false);
  });
});
