/**
 * lib/live-market-state set insurance to 0 when the market group couldn't be parsed, and the registry
 * merge wrote that 0 over the stored row, so the main /api/markets path showed a real "$0" for a fund
 * nobody had read. Unknown is null now (the merge then keeps the stored value). Live devnet account;
 * only the RPC connection and, to force the failure, the SDK's market-group parser are stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ failOi: false }));
// v2.2: both callers read the market group through lib/v22/layout's parseMarketOI, which dispatches
// to the v2.1 or v2.2 SDK parser by the flag; failing it there forces the failure in every mode.
vi.mock("@/lib/v22/layout", async (orig) => {
  const actual = await orig<typeof import("@/lib/v22/layout")>();
  return {
    ...actual,
    parseMarketOI: (d: Uint8Array) => {
      if (h.failOi) throw new Error("bad market group");
      return actual.parseMarketOI(d);
    },
  };
});

import { readLiveMarketStates } from "@/lib/live-market-state";
import { getConfig } from "@/lib/config";

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")) as { market: string; dataBase64: string };
const connection = {
  getMultipleAccountsInfo: async (keys: PublicKey[]) =>
    keys.map(() => ({ data: Buffer.from(fx.dataBase64, "base64"), owner: new PublicKey(getConfig().programId), lamports: 1, executable: false })),
} as never;

describe("live market state insurance", () => {
  it("is null when the market group can't be parsed, not 0", async () => {
    h.failOi = true;
    const s = (await readLiveMarketStates([fx.market], connection)).get(fx.market);
    h.failOi = false;
    expect(s).toBeDefined();
    expect(s!.insurance).toBeNull();
  });

  it("CONTROL: a readable market group gives its insurance balance", async () => {
    const s = (await readLiveMarketStates([fx.market], connection)).get(fx.market);
    expect(typeof s!.insurance).toBe("number");
  });
});
