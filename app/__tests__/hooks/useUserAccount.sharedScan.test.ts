/**
 * useUserAccount — v17 shared-scan integration.
 *
 * Frontend perf audit (2026-07-12): this hook used to be mounted ~8x
 * simultaneously on the desktop trade page, each instance running its OWN
 * `getProgramAccounts` scan on every SlabProvider `raw` change (~every 10s).
 * It's now a thin `useSyncExternalStore` reader over the shared store in
 * lib/userAccountScan.ts. These tests exercise that behavior THROUGH the
 * public hook API (unlike __tests__/lib/userAccountScan.test.ts, which tests
 * the store directly) to prove the hook's return shape and effect wiring
 * still produce the right end-to-end behavior:
 *
 *   1. Two simultaneously-mounted instances sharing the same `raw` reference
 *      (mirrors OrderTicket + PositionsDock both mounting this hook) issue
 *      exactly ONE getProgramAccounts call, and both see the same result.
 *   2. A transient scan error on a later `raw` change keeps the previously
 *      loaded position instead of blanking it to null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
  };
});

import { useUserAccount } from "@/hooks/useUserAccount";

let byteCounter = 0;
function uniquePubkey(): PublicKey {
  byteCounter += 1;
  return new PublicKey(new Uint8Array(32).fill(byteCounter % 256));
}

function makePortfolio(owner: PublicKey, positionSize: bigint) {
  return {
    marketGroupId: new PublicKey(new Uint8Array(32)),
    portfolioAccountId: uniquePubkey(),
    provenanceOwner: owner,
    owner,
    capital: 1_000n,
    pnl: 0n,
    reservedPnl: 0n,
    residualCrystallizedLossAtomsTotal: 0n,
    residualSpentPrincipalAtomsTotal: 0n,
    residualReceivedAtomsTotal: 0n,
    feeCredits: 0n,
    cancelDepositEscrow: 0n,
    lastFeeSlot: 0n,
    activeBitmap: 1n,
    legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: positionSize }],
    sourceDomains: [],
  };
}

describe("useUserAccount — shared v17 scan", () => {
  let wallet: PublicKey;
  let programId: PublicKey;
  let slabAddress: string;
  let getProgramAccounts: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = uniquePubkey();
    programId = uniquePubkey();
    slabAddress = uniquePubkey().toBase58();
    getProgramAccounts = vi.fn();

    mocks.useWalletCompat.mockReturnValue({ publicKey: wallet, connected: true });
    mocks.useConnectionCompat.mockReturnValue({ connection: { getProgramAccounts } });
    mocks.isV17Account.mockReturnValue(true);
  });

  it("dedupes the getProgramAccounts scan across two simultaneously-mounted instances", async () => {
    const portfolioPk = uniquePubkey();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPk, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio(wallet, 42n));

    const raw = new Uint8Array([9, 9, 9]);
    mocks.useSlabState.mockReturnValue({
      accounts: [],
      raw,
      slabAddress,
      programId,
    });

    // Two independent mounts of the SAME hook with the SAME `raw` identity —
    // mirrors two components (e.g. OrderTicket + PositionsDock) both
    // consuming SlabProvider context in the same render.
    const first = renderHook(() => useUserAccount());
    const second = renderHook(() => useUserAccount());

    await waitFor(() => {
      expect(first.result.current).not.toBeNull();
      expect(second.result.current).not.toBeNull();
    });

    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(first.result.current?.account.positionSize).toBe(42n);
    expect(second.result.current?.account.positionSize).toBe(42n);

    first.unmount();
    second.unmount();
  });

  it("keeps the last-good position when a later scan hits a transient RPC error", async () => {
    const portfolioPk = uniquePubkey();
    getProgramAccounts.mockResolvedValueOnce([{ pubkey: portfolioPk, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio(wallet, 7n));

    let raw = new Uint8Array([1]);
    mocks.useSlabState.mockImplementation(() => ({
      accounts: [],
      raw,
      slabAddress,
      programId,
    }));

    const { result, rerender } = renderHook(() => useUserAccount());

    await waitFor(() => {
      expect(result.current?.account.positionSize).toBe(7n);
    });

    // Simulate the next keeper AuthMark push (`raw` changes identity) landing
    // on a 429 — this used to null out the position for every consumer.
    getProgramAccounts.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    raw = new Uint8Array([2]);
    rerender();

    // Give the effect's microtask a tick to run and (fail to) settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current).not.toBeNull();
    expect(result.current?.account.positionSize).toBe(7n); // unchanged, not blanked
  });
});
