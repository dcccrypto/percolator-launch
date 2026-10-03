// @vitest-environment node
/** loadMergedMarketRows (the /api/markets source) with the REAL live-market-state: tombstoned slabs are dropped. */
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  WRAPPER: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  CLOSED: "AcaTmUFncavEBcvUoR57yWU5eJgonUvanWHGYxmXok18",
  GAP: "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy",
  fail: false,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: h.WRAPPER }) }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "not"]) chain[k] = () => chain;
  chain.or = async () => ({ data: [h.CLOSED, h.GAP].map((slab_address) => ({ slab_address, symbol: "X" })), error: null });
  return { getServiceClient: () => chain, getServerNetwork: () => "devnet" };
});
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (h.fail) throw new Error("rpc down");
      const tomb = { data: Buffer.from("00363156435245501200080000000000", "hex"), owner: new PublicKey(h.WRAPPER) };
      // GAP: an existing but unreadable (non-v17) account -> unresolved, kept (fail open)
      const junk = { data: Buffer.from([1, 2, 3]), owner: new PublicKey(h.WRAPPER) };
      return keys.map((k) => (k.toBase58() === h.CLOSED ? tomb : junk));
    },
  }),
}));

import { loadMergedMarketRows } from "@/lib/market-registry";

describe("market registry hides tombstoned (CloseSlab) slabs", () => {
  it("POSITIVE CONTROL: the tombstoned row is dropped; the unreadable one is kept", async () => {
    h.fail = false;
    expect((await loadMergedMarketRows())!.map((r) => r.slab_address)).toEqual([h.GAP]);
  });
  it("NEGATIVE CONTROL: an RPC error keeps both rows", async () => {
    h.fail = true;
    expect((await loadMergedMarketRows())!.map((r) => r.slab_address)).toEqual([h.CLOSED, h.GAP]);
  });
});
