import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";

// ─── Mocks ───

const mockGetAccountInfo = vi.fn();

// IMPORTANT: the connection object must be a STABLE reference,
// otherwise useCallback deps cycle and the hook never settles.
const stableConnection = { getAccountInfo: mockGetAccountInfo };

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: stableConnection }),
}));

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

function persistKeypair(): Keypair {
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));
  storageStore["percolator-pending-slab-keypair"] = json;
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
    storageStore["percolator-pending-slab-keypair"] = "not valid json";

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).toBeNull();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith("percolator-pending-slab-keypair");
  });

  it("handles RPC errors gracefully", async () => {
    persistKeypair();
    mockGetAccountInfo.mockRejectedValue(new Error("RPC connection failed"));

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stuckSlab).toBeNull();
  });

  it("clearStuck removes localStorage entry", async () => {
    persistKeypair();
    mockGetAccountInfo.mockResolvedValue(null);

    const { result } = renderHook(() => useStuckSlabs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.clearStuck();
    });

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith("percolator-pending-slab-keypair");
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
