// @vitest-environment node
/** L-8: Supabase-only registry rows get the world tag from their slab owner (flag on only). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const V1 = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const V21 = {
  WRAPPER: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  STAKE: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  NFT: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  MATCHER: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
};
const SLAB_V1 = "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy";
const SLAB_V21 = "9efj3hdgb2qQvkHKYP9DjZYJQZqC1XiY5XgCiZkvss7u";
const SLAB_GAP = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
// After the cutover the configured wrapper is v2.1; the v1 row must survive and be tagged.
vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/config")>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), network: "devnet", programId: V21.WRAPPER }) };
});
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "not"]) chain[k] = () => chain;
  chain.or = async () => ({ data: [SLAB_V1, SLAB_V21, SLAB_GAP].map((slab_address) => ({ slab_address, symbol: "X" })), error: null });
  return { getServiceClient: () => chain, getServerNetwork: () => "devnet" };
});
const live = (owner: string) => ({ owner, markPriceUsd: 1, oiLongQ: 0, oiShortQ: 0, totalOiQ: 0, totalOiUsd: 0, insurance: 0, vault: 0, cTot: 0, isComplete: true });
vi.mock("@/lib/live-market-state", () => ({
  readLiveMarketStateResolutions: async () => ({
    states: new Map([[SLAB_V1, live(V1)], [SLAB_V21, live(V21.WRAPPER)]]),
    missing: new Set<string>(),
  }),
}));

import { loadMergedMarketRows } from "@/lib/market-registry";
import { __setMoveFlowForTest } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const setEnv = (on: boolean) => {
  const k = { WRAPPER: V21.WRAPPER, STAKE: V21.STAKE, NFT: V21.NFT, MATCHER: V21.MATCHER } as const;
  for (const [n, v] of Object.entries(k)) on ? (process.env[`NEXT_PUBLIC_V21_${n}_PROGRAM_ID`] = v) : delete process.env[`NEXT_PUBLIC_V21_${n}_PROGRAM_ID`];
};
beforeEach(() => {
  setEnv(true);
  __setDevnetV21ForTest(true);
});
afterEach(() => {
  __setMoveFlowForTest(null);
  __setDevnetV21ForTest(null);
  setEnv(false);
});

const bySlab = async () => new Map((await loadMergedMarketRows())!.map((r) => [r.slab_address as string, r as Record<string, unknown>]));

describe("registry rows carry their world (L-8)", () => {
  it("flag on, cutover config: the v1 row survives tagged v1, the v2.1 row tagged v21, an unreadable row untagged", async () => {
    __setMoveFlowForTest(true);
    const m = await bySlab();
    expect(m.get(SLAB_V1)?.world).toBe("v1");
    expect(m.get(SLAB_V21)?.world).toBe("v21");
    expect(m.get(SLAB_GAP)).toBeDefined();
    expect(m.get(SLAB_GAP)).not.toHaveProperty("world");
  });
  it("NEGATIVE CONTROL: flag off tags nothing and, as before, drops the v1 row", async () => {
    __setMoveFlowForTest(false);
    const m = await bySlab();
    expect(m.has(SLAB_V1)).toBe(false);
    expect(m.get(SLAB_V21)).not.toHaveProperty("world");
  });
});
