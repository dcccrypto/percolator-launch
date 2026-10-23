// @vitest-environment node
/**
 * S-1 (v2.2 QA 2026-10-11): GET /api/stake/pools returned {"pools":[]} on the v2.2 preview because it
 * filtered dataSize 408 (SDK 8.0.0 v4) and every v2.2 pool is a 480-byte v5 StakePool. Real pool bytes
 * from the v2.2 stake program 7JrgAUHi… (fixtures/v22-stake-pools-2026-10-11.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../fixtures/v22-stake-pools-2026-10-11.json";

const STAKE = "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V";
const MARKETS = [
  { slab: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", symbol: "SOL" },
  { slab: "ARSMzcMZzgZT2f4GJVbyJsLSuvyuTHvkbaS3fYeoMrvK", symbol: "JUP" },
  { slab: "ALdzXdcRjbHfKyf3XKHDAGWPvDD1Dt1qHBjsaEdN76PA", symbol: "CHILLHOUSE" },
  { slab: "A8XsQeovaevpHLgkWQx3Yg2Q3DuCfjiRvmtagmr53kew", symbol: "PENGU" },
  { slab: "DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU", symbol: "CODEC" },
];
const ANY_KEY = "So11111111111111111111111111111111111111112";

const seen: { dataSize: number | null; program: string | null } = { dataSize: null, program: null };
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async (pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) => {
      seen.program = pid.toBase58();
      seen.dataSize = cfg.filters[0]?.dataSize ?? null;
      return fixture.pools
        .map((p) => ({ pubkey: new PublicKey(p.pubkey), account: { data: Buffer.from(p.b64, "base64"), executable: false, lamports: 1, owner: pid } }))
        .filter((a) => a.account.data.length === seen.dataSize);
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ data: Buffer.alloc(165), executable: false, lamports: 1, owner: PublicKey.default })),
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => {
    throw new Error("no supabase on the preview");
  },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => undefined }));

async function loadRoute(v22: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  vi.stubEnv("NEXT_PUBLIC_STAKE_PROGRAM_ID", STAKE);
  vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", v22 ? "1" : "");
  vi.stubEnv(
    "NEXT_PUBLIC_V22_MARKETS_JSON",
    JSON.stringify(MARKETS.map((m) => ({ slab: m.slab, symbol: m.symbol, name: m.symbol, mainnet_ca: ANY_KEY, dex_pool_address: ANY_KEY, lp_portfolio_address: ANY_KEY }))),
  );
  return import("@/app/api/stake/pools/route");
}

describe("S-1 /api/stake/pools on the v2.2 stake program", () => {
  beforeEach(() => {
    seen.dataSize = null;
    seen.program = null;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("flag on: scans the configured stake program at 480 B and lists the 5 curated v5 pools", async () => {
    const { GET } = await loadRoute(true);
    const body = (await (await GET()).json()) as { pools: Array<{ poolAddress: string; symbol: string; slabAddress: string }> };
    expect(seen.program).toBe(STAKE);
    expect(seen.dataSize).toBe(480);
    expect(body.pools.map((p) => p.symbol).sort()).toEqual(["CHILLHOUSE", "CODEC", "JUP", "PENGU", "SOL"]);
    // The abandoned SOL-v0 pool (slab DBm9…, not in the market list) is not listed.
    expect(body.pools.some((p) => p.poolAddress === "6FXivhmZjjzH6KrA6ErzWCHcAF3Pej6N3bzsukRCzGvA")).toBe(false);
  });

  it("NEGATIVE CONTROL flag off: the SDK size (408) is unchanged, so these v5 pools are not listed", async () => {
    const { GET } = await loadRoute(false);
    const body = (await (await GET()).json()) as { pools: unknown[] };
    expect(seen.dataSize).toBe(408);
    expect(body.pools).toEqual([]);
  });

  it("flag on: a 480-byte account that is not a v5 pool (bad discriminator) is not listed", async () => {
    const { isListableStakePool } = await import("@/lib/v22/stake-pool-scan");
    const { __setDevnetV22ForTest } = await import("@/lib/v22/flag");
    __setDevnetV22ForTest(true);
    try {
      const good = new Uint8Array(Buffer.from(fixture.pools[0].b64, "base64"));
      expect(isListableStakePool(good)).toBe(true);
      const bad = good.slice();
      bad[320] ^= 0xff;
      expect(isListableStakePool(bad)).toBe(false);
    } finally {
      __setDevnetV22ForTest(null);
    }
  });
});
