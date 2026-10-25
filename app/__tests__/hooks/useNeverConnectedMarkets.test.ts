/**
 * #3637: the on-chain creator lookup keeps only markets whose price never advanced past the creation slot (so healthy markets
 * never open a live subscription), keeps a refused registration even when the creation slot is unknown, and reports a failed
 * lookup as an error, never as "none".
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ lookup: vi.fn(), wallet: null as unknown, conn: { connection: {} } }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => h.conn, useWalletCompat: () => ({ publicKey: h.wallet }) }));
vi.mock("@/lib/v22/creator-onchain", () => ({ lookupCreatorMarkets: h.lookup }));

import { useNeverConnectedMarkets } from "@/hooks/useNeverConnectedMarkets";

const K = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const cand = (n: number, creationSlot: bigint | null, lastGood: bigint, neverPushed: boolean | null = null) => ({ slab: K(n), raw: new Uint8Array(), creationSlot, lastGoodOracleSlot: lastGood, neverPushed });

beforeEach(() => {
  h.wallet = K(9);
  h.lookup.mockReset();
});

describe("useNeverConnectedMarkets", () => {
  it("keeps markets whose transaction read says no price was pushed (any gap), drops pushed ones, and uses the slack fallback only when unread", async () => {
    h.lookup.mockResolvedValue([
      cand(1, 100n, 160n, true), // gap 60, read: never pushed
      cand(2, 100n, 105n, false), // read: a price was pushed
      cand(3, 100n, 616n, null), // unread, gap 516 inside the fallback slack
      cand(4, 100n, 5_000n, null), // unread, beyond the slack
      cand(5, null, 100n, null), // nothing known
    ]);
    const { result } = renderHook(() => useNeverConnectedMarkets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markets).toEqual([
      { slab: K(1).toBase58(), creationSlot: 100n, neverPushed: true },
      { slab: K(3).toBase58(), creationSlot: 100n, neverPushed: null },
    ]);
    expect(result.current.error).toBe(false);
  });
  it("a refused registration keeps a market whose creation slot is unknown", async () => {
    h.lookup.mockResolvedValue([cand(3, null, 100n)]);
    const refused = (slab: string): boolean => slab === K(3).toBase58();
    const { result } = renderHook(() => useNeverConnectedMarkets(refused));
    await waitFor(() => expect(result.current.markets.length).toBe(1));
  });
  it("a failed lookup is an error, not an empty list", async () => {
    h.lookup.mockRejectedValue(new Error("rpc"));
    const { result } = renderHook(() => useNeverConnectedMarkets());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.markets).toEqual([]);
  });
  it("no wallet: no lookup", async () => {
    h.wallet = null;
    renderHook(() => useNeverConnectedMarkets());
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
