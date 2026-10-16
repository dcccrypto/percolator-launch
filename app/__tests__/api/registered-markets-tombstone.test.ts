// @vitest-environment node
/**
 * End to end through the REAL readSlabExistence: a slab that went through CloseSlab (16-byte
 * wrapper-owned tombstone, never null) must disappear from /api/playground/registered-markets,
 * while a live slab, an RPC error and a foreign-owned lookalike must not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  WRAPPER: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  OTHER: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
  CLOSED: "Vote111111111111111111111111111111111111111",
  LIVE: "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy",
  LOOKALIKE: "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg",
  replies: new Map<string, unknown>(),
  rpcFails: false,
  readOk: true,
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: h.WRAPPER }) }));
vi.mock("@/lib/blocklist", () => ({ BLOCKED_SLAB_ADDRESSES: new Set<string>() }));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    throw new Error("not configured"); // DB filter skipped: only the chain filter is under test
  },
}));
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarketsChecked: async () => ({ ok: h.readOk, markets:
    [h.CLOSED, h.LIVE, h.LOOKALIKE].map((slabAddress) => ({
      slabAddress,
      marketAddress: slabAddress,
      poolAddress: "11111111111111111111111111111111",
      dexType: "test",
      symbol: "T",
      label: "T/USDC",
      mainnetCA: null,
      collateral: "11111111111111111111111111111111",
      registeredAt: 1,
    })) }),
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (h.rpcFails) throw new Error("rpc down");
      return keys.map((k) => h.replies.get(k.toBase58()) ?? null);
    },
  }),
}));

import { GET } from "@/app/api/playground/registered-markets/route";

const TOMB = Buffer.from("00363156435245501200080000000000", "hex"); // wrapper write_closed_market_tombstone
const LIVE_SLICE = Buffer.from("00363156435245501200010000000000" + "00", "hex"); // kind 1, 17-byte slice
const info = (data: Buffer, owner: string) => ({ data, owner: new PublicKey(owner) });
const slabs = async () =>
  ((await (await GET()).json()) as { markets: Array<{ slabAddress: string }> }).markets.map((m) => m.slabAddress);

beforeEach(() => {
  h.rpcFails = false;
  h.readOk = true;
  h.replies = new Map<string, unknown>([
    [h.CLOSED, info(TOMB, h.WRAPPER)],
    [h.LIVE, info(LIVE_SLICE, h.WRAPPER)],
    [h.LOOKALIKE, info(TOMB, h.OTHER)],
  ]);
});

describe("registered-markets hides CloseSlab tombstones (real readSlabExistence)", () => {
  it("POSITIVE CONTROL: the wrapper-owned tombstone is dropped, the live slab and the foreign lookalike stay", async () => {
    expect(await slabs()).toEqual([h.LIVE, h.LOOKALIKE]);
  });

  it("POSITIVE CONTROL: an explicit null (garbage-collected) is also dropped when a sibling exists", async () => {
    h.replies.delete(h.CLOSED);
    expect(await slabs()).toEqual([h.LIVE, h.LOOKALIKE]);
  });

  it("NEGATIVE CONTROL: an RPC error hides nothing", async () => {
    h.rpcFails = true;
    expect(await slabs()).toEqual([h.CLOSED, h.LIVE, h.LOOKALIKE]);
  });
});

describe("registered-markets says when the store read failed", () => {
  it("a failed read still answers 200 with what it has, flagged complete: false", async () => {
    h.readOk = false;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { complete?: boolean; markets: unknown[] };
    expect(body.complete).toBe(false);
    expect(body.markets.length).toBeGreaterThan(0);
  });

  it("CONTROL: a good read carries no complete field", async () => {
    expect(await (await GET()).json()).not.toHaveProperty("complete");
  });
});
