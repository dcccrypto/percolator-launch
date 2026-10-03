/**
 * useMarketFillCap.sideRoomQ — the order ticket's "room on this side" on a DRIFTED market
 * (Gprscv7A, 2026-10-03: matcher counter +cap, LP really flat). Pre-upgrade the ticket offers
 * min(counter, real); once the upgraded wrapper + matcher are detected, the real position.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey, Keypair } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({ getMatcherCaps: vi.fn(), getLpInventoryState: vi.fn() }));

import { useMarketFillCap } from "../../hooks/useMarketFillCap";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, getLpInventoryState } from "@/lib/matcherCaps";

const CAP = 14_025_245_441n;
const SLAB = Keypair.generate().publicKey.toBase58();

async function render(syncLive: boolean, realQ: bigint | null = 0n) {
  vi.mocked(getLpInventoryState).mockResolvedValue({ counterQ: CAP, realQ, syncLive });
  const h = renderHook(() => useMarketFillCap(SLAB));
  await act(async () => {});
  return h.result.current!;
}

describe("useMarketFillCap.sideRoomQ on a drifted market", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: {} } as never);
    vi.mocked(useSlabState).mockReturnValue({ programId: new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB") } as never);
    vi.mocked(getMatcherCaps).mockResolvedValue({ maxFillAbs: CAP / 4n, maxInventoryAbs: CAP });
  });

  it("pre-upgrade: shorts blocked (what the stale matcher fills), longs capped at cap (no 2x bypass)", async () => {
    const r = await render(false);
    expect(r.inventoryBase).toBe(CAP);
    expect(r.lpRealQ).toBe(0n);
    expect(r.sideRoomQ("short")).toBe(0n);
    expect(r.sideRoomQ("long")).toBe(CAP);
  });

  it("NEGATIVE CONTROL: without the real position the counter alone offers 2x cap on longs", async () => {
    const r = await render(false, null);
    expect(r.sideRoomQ("long")).toBe(2n * CAP);
  });

  it("post-upgrade detected: the phantom short limit is gone", async () => {
    const r = await render(true);
    expect(r.syncLive).toBe(true);
    expect(r.sideRoomQ("short")).toBe(CAP);
    expect(r.sideRoomQ("long")).toBe(CAP);
  });
});
