/**
 * #3468 follow-up: wrapping an open position in a Position NFT must not read as "the protocol closed it".
 * A wrapped row is excluded from the remembered set (it can be sent away), so without the guard the
 * position looked vanished, the indexer had no trade for it (a wrap is not a trade), and a
 * "most likely a liquidation" notice appeared 3 minutes later.
 */
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const W = new PublicKey("11111111111111111111111111111112");
const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const state = vi.hoisted(() => ({ positions: [] as unknown[] }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: true, publicKey: W }) }));
vi.mock("@/hooks/usePortfolio", () => ({ usePortfolio: () => ({ loading: false, error: null, positions: state.positions }) }));
import { useClosedPositionNotices } from "@/hooks/useClosedPositionNotices";

const pos = (wrapped: boolean, idx = 3) => ({
  slabAddress: SLAB,
  symbol: "SOL",
  idx: wrapped ? 0 : idx, // wrapped rows are built with idx 0 (buildV17Position)
  nftWrapped: wrapped,
  oraclePriceE6: 100_000_000n,
  liquidationPriceE6: 50_000_000n,
  account: { positionSize: 5_000_000n, owner: wrapped ? { toBase58: () => "NftEscrowPda1111111111111111111111111111111" } : W },
});

async function run(second: unknown[]) {
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
  state.positions = [pos(false)];
  const { result, rerender } = renderHook(() => useClosedPositionNotices());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  vi.setSystemTime(new Date("2026-10-13T10:05:00Z"));
  state.positions = second;
  rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  return result.current.notices;
}

describe("useClosedPositionNotices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    // the indexer holds the opening trade only (an hour before): "no trade since it was last seen open"
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ trades: [{ slab_address: SLAB, created_at: new Date(Date.now() - 3_600_000).toISOString() }], total: 1 }),
    })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("CONTROL: a position that is simply gone (no trade since) is noticed", async () => {
    const notices = await run([]);
    expect(notices).toHaveLength(1);
    expect(notices[0].slab).toBe(SLAB);
  });

  it("a position wrapped in a Position NFT is still open: no notice", async () => {
    expect(await run([pos(true)])).toEqual([]);
  });
});
