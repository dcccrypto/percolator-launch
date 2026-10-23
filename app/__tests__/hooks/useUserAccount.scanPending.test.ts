/**
 * GH#2707: useUserAccountScanPending() — the loading channel useUserAccount()
 * cannot express. Exercised through the real hooks + real shared store; only
 * the wallet / slab context and the RPC are doubled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  isV17Account: vi.fn(),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: mocks.isV17Account,
}));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return { ...actual, isV17Account: mocks.isV17Account };
});

import { useUserAccount, useUserAccountScanPending } from "@/hooks/useUserAccount";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";

let n = 50;
const uniquePubkey = () => new PublicKey(new Uint8Array(32).fill(++n % 256));

function both() {
  return { account: useUserAccount(), pending: useUserAccountScanPending() };
}

describe("useUserAccountScanPending (GH#2707)", () => {
  let wallet: PublicKey;
  let programId: PublicKey;
  let slabAddress: string;
  let getProgramAccounts: ReturnType<typeof vi.fn>;
  const raw = new Uint8Array([4, 4, 4]);

  beforeEach(() => {
    __setUnknownLotExpForTest(0);
    vi.clearAllMocks();
    wallet = uniquePubkey();
    programId = uniquePubkey();
    slabAddress = uniquePubkey().toBase58();
    getProgramAccounts = vi.fn();
    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getProgramAccounts } });
    mocks.isV17Account.mockReturnValue(true);
    mocks.useSlabState.mockImplementation(() => ({ accounts: [], raw, slabAddress, programId }));
  });

  it("is pending while the first scan is in flight, then resolves to 'no account'", async () => {
    let resolve!: (v: unknown[]) => void;
    getProgramAccounts.mockReturnValue(new Promise((r) => { resolve = r; }));

    const { result } = renderHook(both);
    // In flight: the account is null AND we know it is not known yet.
    expect(result.current.account).toBeNull();
    expect(result.current.pending).toBe(true);

    await act(async () => { resolve([]); });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.account).toBeNull(); // now a real "no account"
  });

  it("stays pending when the first scan fails", async () => {
    getProgramAccounts.mockRejectedValue(new Error("429 Too Many Requests"));
    const { result } = renderHook(both);
    await waitFor(() => expect(getProgramAccounts).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.pending).toBe(true);
    expect(result.current.account).toBeNull();
  });

  it("is not pending with no wallet connected", () => {
    mocks.useWalletCompat.mockReturnValue({ publicKey: null, connected: false });
    const { result } = renderHook(both);
    expect(result.current.pending).toBe(false);
    expect(getProgramAccounts).not.toHaveBeenCalled();
  });

  it("is not pending on a non-v17 slab (synchronous account list)", () => {
    mocks.isV17Account.mockReturnValue(false);
    const { result } = renderHook(both);
    expect(result.current.pending).toBe(false);
  });
});
