/**
 * "Start Over" after a failed launch must not delete the in-flight
 * recovery record for a market that is already on chain.
 * Sibling: a recovery card's discard on /create must only delete ITS slab's record,
 * not the slab useCreateMarket hydrated from the "last in-flight" pointer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Keypair, SystemProgram } from "@solana/web3.js";

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const key = (s: string) => `percolator:in-flight-market:${s}`;
const seed = (s: string, lastStep: number) => {
  localStorage.setItem(key(s), JSON.stringify({ slabAddress: s, slabSecretKey: [], adminAddress: SystemProgram.programId.toBase58(), collateralAta: s, collateralMint: s, programId: s, network: "devnet", createdAt: 1, lastStep }));
  localStorage.setItem("percolator:last-in-flight-key", key(s));
};

globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as typeof fetch;
const connection = { rpcEndpoint: "https://api.devnet.solana.com", getBalance: async () => 100e9, getAccountInfo: async () => null };
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: SystemProgram.programId, connected: true }),
  useConnectionCompat: () => ({ connection }),
}));
const g = globalThis as { __createState?: unknown; __stuck?: unknown[]; __refresh?: ReturnType<typeof vi.fn> };
vi.mock("@/hooks/useCreateMarket", async (orig) => ({
  ...(await orig<object>()),
  useCreateMarket: () => ({ state: g.__createState, create: vi.fn(), reset: vi.fn(), restoreSlabKeypair: vi.fn(), retryKeeperRegistration: vi.fn(), cancelInFlightLaunch: vi.fn() }),
}));
vi.mock("@/hooks/useStuckSlabs", () => ({
  useStuckSlabs: () => ({
    stuckSlab: g.__stuck?.[0] ?? null,
    stuckSlabs: g.__stuck ?? [],
    loading: false,
    refresh: () => g.__refresh?.(),
    clearStuck: (s: string) => localStorage.removeItem(`percolator:in-flight-market:${s}`),
  }),
}));
vi.mock("@/hooks/useCloseMarket", () => ({ useCloseMarket: () => ({ closeSlab: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useDuplicateMarket", () => ({ useDuplicateMarket: () => ({ checking: false, duplicates: [] }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));

import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";

const IDLE = { step: 0, loading: false, error: null, stepErrors: {}, txSigs: [], slabAddress: null };

describe("#7 Start Over keeps the recovery record", () => {
  beforeEach(() => { localStorage.clear(); g.__stuck = []; g.__refresh = vi.fn(); });

  it.each([1, 2, 3, 4, 5])("step %i failed: Start Over leaves the record in place", async (step) => {
    seed(A, step);
    g.__createState = { ...IDLE, step, error: "Transaction failed", slabAddress: A };
    render(<CreateMarketWizard />);
    await act(async () => { fireEvent.click(screen.getByTestId("wizard-reset")); });
    expect(localStorage.getItem(key(A))).not.toBeNull();
  });

  it("discarding card B does not delete hydrated slab A's record", async () => {
    seed(B, 0);
    seed(A, 3); // A is the pointer: useCreateMarket's mount effect hydrates slabAddress = A
    g.__createState = { ...IDLE, slabAddress: A };
    g.__stuck = [{ publicKey: Keypair.generate().publicKey, isInitialized: false, exists: false, keypair: null, lamports: 0, owner: null, lastStep: 0, collateralAta: B, state: {} }];
    // card's own slab is B
    (g.__stuck[0] as { publicKey: { toBase58: () => string } }).publicKey = { toBase58: () => B };
    render(<CreateMarketWizard />);
    await act(async () => { fireEvent.click(screen.getByText(/CLEAR & START FRESH/)); });
    expect(localStorage.getItem(key(B))).toBeNull();
    expect(localStorage.getItem(key(A))).not.toBeNull();
  });

  it("Start Over re-reads the in-flight records (useStuckSlabs refresh)", async () => {
    seed(A, 2);
    g.__createState = { ...IDLE, step: 2, error: "Transaction failed", slabAddress: A };
    render(<CreateMarketWizard />);
    await act(async () => { fireEvent.click(screen.getByTestId("wizard-reset")); });
    expect(g.__refresh).toHaveBeenCalled();
  });
});
