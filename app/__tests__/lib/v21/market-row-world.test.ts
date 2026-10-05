import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const V1 = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const V21 = {
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
};
const FOREIGN = "11111111111111111111111111111111";

// Cutover: the GLOBAL config is v2.1. The label must still come from the row, not the config.
vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/config")>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), network: "devnet", programId: V21.wrapper }) };
});

import { __setMoveFlowForTest } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { isV1Market, marketRowWorld } from "@/lib/v21/worlds";

const env = { WRAPPER: V21.wrapper, STAKE: V21.stake, NFT: V21.nft, MATCHER: V21.matcher } as const;
beforeEach(() => {
  for (const [k, v] of Object.entries(env)) process.env[`NEXT_PUBLIC_V21_${k}_PROGRAM_ID`] = v;
  __setDevnetV21ForTest(true);
  __setMoveFlowForTest(true);
});
afterEach(() => {
  __setMoveFlowForTest(null);
  __setDevnetV21ForTest(null);
  for (const k of Object.keys(env)) delete process.env[`NEXT_PUBLIC_V21_${k}_PROGRAM_ID`];
});

describe("marketRowWorld (L-4/L-8): the row's own world, never the global config", () => {
  it("after cutover (config = v2.1) a v1 row WITHOUT on-chain data is labelled via the API world tag", () => {
    expect(isV1Market({ programId: null, world: "v1" })).toBe(true);
  });
  it("a v1 row with on-chain data is labelled by its own program id", () => {
    expect(isV1Market({ programId: V1 })).toBe(true);
  });
  it("a v2.1 row is not labelled, by program id or by tag", () => {
    expect(isV1Market({ programId: V21.wrapper })).toBe(false);
    expect(isV1Market({ world: "v21" })).toBe(false);
  });
  it("the program id wins over a conflicting tag", () => {
    expect(marketRowWorld({ programId: V21.wrapper, world: "v1" })).toBe("v21");
  });
  it("unknown world: no label, no block (fail open, documented)", () => {
    expect(marketRowWorld({})).toBeNull();
    expect(marketRowWorld({ programId: null, world: null })).toBeNull();
    expect(marketRowWorld({ world: "bogus" })).toBeNull();
    expect(isV1Market({})).toBe(false);
    expect(marketRowWorld({ programId: FOREIGN, world: "v1" })).toBeNull();
  });
  it("flags off: always null, even for a v1 row", () => {
    __setMoveFlowForTest(false);
    expect(marketRowWorld({ programId: V1, world: "v1" })).toBeNull();
    expect(isV1Market({ world: "v1" })).toBe(false);
  });
});

describe("call sites use the helper, not the global config (source guard)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
  it("markets list and MarketInfoBar decide the badge with isV1Market and never with getConfig", () => {
    for (const f of ["app/markets/page.tsx", "components/trade/MarketInfoBar.tsx"]) {
      const s = read(f);
      expect(s).toContain("isV1Market(");
      expect(s).not.toMatch(/isV1CloseOnly\([^)]*getConfig/);
      expect(s).not.toContain("getConfig().programId");
    }
  });
  it("the markets list passes the API world tag for rows without on-chain data", () => {
    expect(read("app/markets/page.tsx")).toContain("world: m.supabase?.world");
  });
  it("/api/markets runs the v1 and v2.1 scans in parallel (L-9)", () => {
    const s = read("app/api/markets/route.ts");
    expect(s).toContain("Promise.all(");
    expect(s).toContain("const scans = await Promise.all(");
    expect(s).not.toMatch(/await discoverMarkets\(connection, new PublicKey\(wrapperId\)/);
  });
});
