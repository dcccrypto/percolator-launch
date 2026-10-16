/**
 * v2.2 browser E2E 2026-10-16: with no Supabase (the v2.2 preview), the portfolio's "Active Markets" read 27 while
 * /markets listed 9. /api/stats counted every wrapper account discovery found (abandoned launches, test slabs);
 * /api/markets lists only the curated seeds plus registered launches, minus blocked and unfinished markets.
 *
 * Drives BOTH real route handlers over the SAME mocked discovery set (only chain / Blob / Supabase I/O is mocked)
 * and checks /api/stats counts exactly what the /markets page lists from /api/markets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";

const STAKE_POOL_PDA = new PublicKey("So11111111111111111111111111111111111111112");
const CREATOR = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const CURATED = [pk(1), pk(2), pk(3)];
const REGISTERED = [pk(4), pk(5)];
const REGISTERED_INCOMPLETE = pk(6);
const REGISTERED_NO_POOL = pk(7);
const JUNK = [pk(10), pk(11), pk(12), pk(13), pk(14), pk(15)];

const mocks = vi.hoisted(() => ({ discovered: [] as unknown[] }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
    programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
    vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
    rpcUrl: "https://api.devnet.solana.com",
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    throw new Error("no supabase");
  },
}));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => null, MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/indexer-db", () => ({
  hasIndexerDb: () => false,
  queryStatsAggregate: vi.fn(),
  queryKnownSlabs: vi.fn(),
}));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }),
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) }),
}));
vi.mock("@/lib/lp-portfolio", () => ({
  // Every market has LP capital (so none is a zombie); the listing rules alone decide.
  getKnownMarketLpCapitals: async (_c: unknown, slabs: string[]) => new Map(slabs.map((s) => [s, 1_000_000_000n])),
  scanEnabledMarketLpCapitals: async () => new Map(),
}));
vi.mock("@/lib/playground-slab-meta", async (orig) => {
  const actual = await orig<typeof import("@/lib/playground-slab-meta")>();
  return {
    ...actual,
    PLAYGROUND_SLAB_META: Object.fromEntries(
      CURATED.map((s, i) => [s.toBase58(), { symbol: `C${i}`, name: `Curated ${i}`, dex_pool_address: POOL, mainnet_ca: MINT.toBase58() }]),
    ),
  };
});
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => [
    ...REGISTERED.map((s, i) => ({ slabAddress: s.toBase58(), symbol: `R${i}`, label: `Registered ${i}`, poolAddress: POOL })),
    { slabAddress: REGISTERED_INCOMPLETE.toBase58(), symbol: "HALF", label: "Half", poolAddress: POOL },
    { slabAddress: REGISTERED_NO_POOL.toBase58(), symbol: "NOPOOL", label: "No pool", poolAddress: null },
  ],
}));
// The routes reach discovery through the version-aware adapter: mock it there so the test holds with the v2.2 flag on
// and off.
vi.mock("@/lib/v22/discovery", async (orig) => {
  const actual = await orig<typeof import("@/lib/v22/discovery")>();
  return { ...actual, discoverMarkets: async () => mocks.discovered };
});
vi.mock("@percolatorct/sdk", async (orig) => {
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  return {
    ...actual,
    deriveStakePool: () => [STAKE_POOL_PDA],
    isV17Account: () => false,
  };
});

function market(slab: PublicKey, marketauth: PublicKey) {
  return {
    slabAddress: slab,
    programId: PROG,
    configV17: { collateralMint: MINT, marketauth, oracleMode: 3, markEwmaE6: 2_000_000n, tradeFeeBps: 10n },
  };
}

async function callStats(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/stats/route");
  return (await (await GET(new NextRequest("http://localhost/api/stats"))).json()) as Record<string, unknown>;
}

async function marketsPageListed(): Promise<string[]> {
  const { GET } = await import("@/app/api/markets/route");
  const { isListedMarketRow } = await import("@/lib/listed-markets");
  const res = await GET(new NextRequest("http://localhost/api/markets?include_zombie=true&limit=500"));
  expect(res.headers.get("X-Percolator-Data-Source")).toBe("on-chain-discovery");
  const body = (await res.json()) as { markets: Array<Record<string, unknown>> };
  return body.markets.filter((m) => isListedMarketRow(m.slab_address as string, m)).map((m) => m.slab_address as string);
}

describe("/api/stats without Supabase counts what /markets lists (v2.2 preview 27 vs 9)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.discovered = [
      ...CURATED.map((s) => market(s, STAKE_POOL_PDA)),
      ...REGISTERED.map((s) => market(s, STAKE_POOL_PDA)),
      market(REGISTERED_INCOMPLETE, CREATOR),
      market(REGISTERED_NO_POOL, STAKE_POOL_PDA),
      ...JUNK.map((s) => market(s, STAKE_POOL_PDA)),
    ];
  });

  it("CONTROL: /markets lists the curated + registered priced markets, not the unregistered or unfinished ones", async () => {
    const listed = await marketsPageListed();
    expect(listed.sort()).toEqual([...CURATED, ...REGISTERED].map((s) => s.toBase58()).sort());
  });

  it("Active Markets (activeTotal) and totalMarkets equal the /markets count, not the raw discovery count", async () => {
    const listed = await marketsPageListed();
    const stats = await callStats();
    expect(stats.live).toBe(true);
    expect(stats.totalMarkets).toBe(listed.length);
    expect(stats.activeTotal).toBe(listed.length);
    expect(stats.totalListedMarkets).toBe(listed.length);
    expect(stats.activeTotal).not.toBe(mocks.discovered.length);
  });

  it("open interest is the chain-read OI of the listed markets only (not zeroed by the placeholder account count)", async () => {
    // 1 long + 1 short contract (Q 1e6 each) at $2 mark on every market: $4 per market.
    const oi = new Map<string, { totalLongOiQ: bigint; totalShortOiQ: bigint; insuranceBalance: bigint }>();
    for (const m of mocks.discovered as Array<{ slabAddress: PublicKey }>) {
      oi.set(m.slabAddress.toBase58(), { totalLongOiQ: 1_000_000n, totalShortOiQ: 1_000_000n, insuranceBalance: 0n });
    }
    vi.doMock("@/lib/server-rpc", () => ({
      getServerConnection: () => ({
        getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => ({ data: Buffer.from(k.toBytes()) })),
      }),
    }));
    vi.doMock("@/lib/v22/layout", async (orig) => {
      const actual = await orig<typeof import("@/lib/v22/layout")>();
      return {
        ...actual,
        isWrapperAccount: () => true,
        parseMarketOI: (data: Uint8Array) => oi.get(new PublicKey(data.slice(0, 32)).toBase58()),
      };
    });
    vi.doMock("@/lib/v17-engine-config", async (orig) => {
      const actual = await orig<typeof import("@/lib/v17-engine-config")>();
      return { ...actual, parseV17RiskParams: () => null, readMaxPortfolioAssets: () => 1 };
    });
    vi.doMock("@/lib/v22/lot", async (orig) => {
      const actual = await orig<typeof import("@/lib/v22/lot")>();
      return { ...actual, lotExpOf: () => 0 };
    });
    const listed = await marketsPageListed();
    const stats = await callStats();
    expect(stats.totalOpenInterest).toBeCloseTo(4 * listed.length, 6);
  });
});
