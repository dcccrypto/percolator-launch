// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const SLAB = PublicKey.unique().toBase58();
const PAYER = PublicKey.unique();

const h = vi.hoisted(() => ({
  slot: 1_000n as bigint,
  raw: new Uint8Array([1]) as Uint8Array | null,
  status: null as unknown,
  resolved: false,
  freshStatus: { refusalCode: null, ageSlots: 5000n } as unknown,
  simulateForGate: vi.fn(),
  sendTx: vi.fn(),
  loadOwn: vi.fn(),
  refresh: vi.fn(),
  getAccountInfo: vi.fn(),
  getSlot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getAccountInfo: h.getAccountInfo, getSlot: h.getSlot } }),
  useWalletCompat: () => ({ publicKey: PAYER }),
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.slot }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    raw: h.raw,
    programId: PublicKey.unique(),
    config: { collateralMint: PublicKey.unique() },
    refresh: h.refresh,
  }),
}));
vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => true }));
vi.mock("@/lib/tx", () => ({
  simulateForGate: h.simulateForGate,
  sendTx: h.sendTx,
  broadcastSignedTx: vi.fn(),
  buildBatchTx: vi.fn(),
  getFreshBlockhash: vi.fn(),
  getPriorityFee: vi.fn(),
  signAllCompat: vi.fn(),
}));
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({
  loadOwnPortfolios: h.loadOwn,
  ownResolvedPayIxs: vi.fn(),
  ownerClosePortfolioIx: vi.fn(),
}));
vi.mock("@percolatorct/sdk", () => ({ deriveVaultAuthority: () => [PublicKey.unique(), 0] }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: () => PublicKey.unique() }));
vi.mock("@/lib/v22/stale-resolve", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/stale-resolve")>();
  return {
    ...real,
    buildResolveStalePermissionlessIxV22: () => ({ programId: PublicKey.unique(), keys: [], data: Buffer.alloc(1) }),
    marketResolvedV22: () => h.resolved,
    // First call serves the memo (cached bytes); the fresh read inside settle() uses h.freshStatus.
    staleResolveStatusV22: (raw: Uint8Array) => (raw.length === 1 ? h.status : h.freshStatus),
    showStaleSettle: (s: unknown) => s !== null && (s as { refusalCode: number | null }).refusalCode === null,
  };
});

import { useStaleResolve } from "@/hooks/useStaleResolve";
import { STALE_SETTLE_COPY } from "@/lib/v22/stale-resolve";

const ixErr = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });

beforeEach(() => {
  vi.clearAllMocks();
  h.slot = 1_000n;
  h.raw = new Uint8Array([1]);
  h.status = { refusalCode: null, ageSlots: 5000n };
  h.freshStatus = { refusalCode: null, ageSlots: 5000n };
  h.resolved = false;
  h.getAccountInfo.mockResolvedValue({ data: new Uint8Array([1, 2]) });
  h.getSlot.mockResolvedValue(1_000);
  h.simulateForGate.mockResolvedValue({ err: null });
  h.sendTx.mockResolvedValue("sig");
  h.loadOwn.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("useStaleResolve", () => {
  it("lead 2: a landed-but-failed tag 39 (sendTx throws) is NOT marked settled and never reaches the exit", async () => {
    h.sendTx.mockRejectedValue(new Error('Transaction failed: {"InstructionError":[2,{"Custom":27}]}'));
    const { result } = renderHook(() => useStaleResolve(SLAB, true));
    await act(async () => result.current.settle());
    expect(h.loadOwn).not.toHaveBeenCalled();
    expect(result.current.done).toBeNull();
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
  });

  it("happy path: tag 39 lands, no funds -> settledNoFunds", async () => {
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle());
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
  });

  it("lead 4: slab is released on the early return, on throws and on success (a second click works)", async () => {
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle()); // early return (!hasFunds)
    await act(async () => result.current.settle());
    expect(h.sendTx).toHaveBeenCalledTimes(2);
    h.sendTx.mockRejectedValueOnce(new Error("boom"));
    await act(async () => result.current.settle());
    await act(async () => result.current.settle());
    expect(h.sendTx).toHaveBeenCalledTimes(4);
    expect(result.current.busy).toBe(false);
  });

  it("lead 4: a concurrent second click is ignored while the first is in flight", async () => {
    let release!: (v: string) => void;
    h.sendTx.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    let first!: Promise<void>;
    act(() => {
      first = result.current.settle();
    });
    await act(async () => result.current.settle());
    await act(async () => {
      release("sig");
      await first;
    });
    expect(h.sendTx).toHaveBeenCalledTimes(1);
  });

  it("lead 1: Custom 21 at the tag-39 index (2, after the 2-ix compute prelude) means already settled -> carries on", async () => {
    h.simulateForGate.mockResolvedValue({ err: ixErr(2, 21) });
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle());
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
  });

  it("lead 1: Custom 21 at the compute-budget prelude index (0) is currently ALSO read as 'already settled'", async () => {
    h.simulateForGate.mockResolvedValue({ err: ixErr(0, 21) });
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle());
    // Documents the latent gap: index is not checked. Unreachable in practice (ComputeBudget never returns Custom).
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
  });

  it("refusal 27 maps to the calm 'not yet' line", async () => {
    h.simulateForGate.mockResolvedValue({ err: ixErr(2, 27) });
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle());
    expect(result.current.error).toBe(STALE_SETTLE_COPY.notYet);
  });

  it("missing market account -> generic", async () => {
    h.getAccountInfo.mockResolvedValue(null);
    h.freshStatus = null;
    const { result } = renderHook(() => useStaleResolve(SLAB, false));
    await act(async () => result.current.settle());
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
  });

  it("lead 5: wallet decline before settle -> cancelled; after settle -> declinedAfterSettle", async () => {
    h.sendTx.mockRejectedValue(new Error("User rejected the request."));
    const { result } = renderHook(() => useStaleResolve(SLAB, true));
    await act(async () => result.current.settle());
    expect(result.current.error).toBe(STALE_SETTLE_COPY.cancelled);
    h.sendTx.mockResolvedValue("sig");
    h.loadOwn.mockRejectedValue(new Error("User declined"));
    await act(async () => result.current.settle());
    expect(result.current.error).toBe(STALE_SETTLE_COPY.declinedAfterSettle);
  });

  it("lead 5: RPC text containing 'cancelled' is classified as a wallet decline", async () => {
    h.sendTx.mockRejectedValue(new Error("RPC node: request cancelled (timeout)"));
    const { result } = renderHook(() => useStaleResolve(SLAB, true));
    await act(async () => result.current.settle());
    expect(result.current.error).toBe(STALE_SETTLE_COPY.cancelled);
  });

  it("lead 3: stoppedAtLabel is derived as (now - age), so a frozen memo still names the same stop time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00"));
    const { result, rerender } = renderHook(() => useStaleResolve(SLAB, true));
    const first = result.current.view;
    expect(first?.kind).toBe("stale");
    vi.setSystemTime(new Date("2026-11-18T12:07:00"));
    rerender(); // same status object -> memo reused
    expect(result.current.view).toBe(first);
    // New slot (status recomputed): label and minutes recompute together from the same instant.
    h.slot = 1_020n;
    h.status = { refusalCode: null, ageSlots: 5020n };
    rerender();
    expect(result.current.view?.minutes).toBeGreaterThanOrEqual(first!.minutes);
  });

  it("settled market with funds -> settled view; without funds -> null", () => {
    h.status = { refusalCode: 21, ageSlots: 5000n };
    h.resolved = true;
    expect(renderHook(() => useStaleResolve(SLAB, true)).result.current.view?.kind).toBe("settled");
    expect(renderHook(() => useStaleResolve(SLAB, false)).result.current.view).toBeNull();
  });
});
